const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const { auth } = require("express-oauth2-jwt-bearer");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const N8N_SCAN_WEBHOOK_URL = process.env.N8N_SCAN_WEBHOOK_URL || "";
const N8N_BASE = process.env.N8N_BASE_URL || "https://automatisierung.automatisierungen-ki.de/webhook";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";
const RESET_SECRET = process.env.RESET_SECRET || "";

const N8N_B4S_WF02_SELECTED_WEBHOOK_URL = process.env.N8N_B4S_WF02_SELECTED_WEBHOOK_URL || "";
const N8N_C4_WF02_SELECTED_WEBHOOK_URL = process.env.N8N_C4_WF02_SELECTED_WEBHOOK_URL || "";
const N8N_INTERNAL_TOKEN = process.env.N8N_INTERNAL_TOKEN || "";

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || "dev-ompvmvxk02ucpm3p.us.auth0.com";
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || "https://api.automatisierungen-ki.de";
const NAMESPACE = "https://api.automatisierungen-ki.de";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const safeFetch = (...args) => {
  if (typeof fetch === "function") return fetch(...args);
  return import("node-fetch").then(({ default: fetchFn }) => fetchFn(...args));
};

const checkJwt = auth({
  audience: AUTH0_AUDIENCE,
  issuerBaseURL: `https://${AUTH0_DOMAIN}/`,
  tokenSigningAlg: "RS256"
});

function getCompanyId(req) {
  const payload = req.auth?.payload;
  if (!payload) return null;

  const fromClaim = payload[`${NAMESPACE}/company_id`];
  if (fromClaim) return parseInt(fromClaim, 10);

  if (req.query.company_id) return parseInt(req.query.company_id, 10);

  return null;
}

function getUserEmail(req) {
  const payload = req.auth?.payload || {};
  return payload.email || payload[`${NAMESPACE}/email`] || null;
}

function parsePositiveInt(value, fallback, max = null) {
  const parsed = parseInt(value, 10);
  const safe = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return max ? Math.min(safe, max) : safe;
}

function chunkArray(values, size) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function getSelectedLeadSplit(policy, leadIds) {
  if (policy.key !== "company4_recruiting") {
    return {
      videoLeadIds: leadIds,
      emailOnlyLeadIds: [],
      creditsToUse: leadIds.length
    };
  }

  const videoLimit = policy.videoLimit || 250;
  const emailOnlyLimit = policy.emailOnlyLimit || 500;
  const videoLeadIds = leadIds.slice(0, videoLimit);
  const emailOnlyLeadIds = leadIds.slice(videoLimit, videoLimit + emailOnlyLimit);

  return {
    videoLeadIds,
    emailOnlyLeadIds,
    creditsToUse: videoLeadIds.length
  };
}

/*
 * Tenant-spezifische Regeln für die Auswahl-Analyse.
 * Company 2 (Brand4Social) und Company 3 (Viralityfilms)
 * nutzen dieselbe UI-Funktion, aber getrennte Prozesse.
 */
const COMPANY_IDS = Object.freeze({
  BRAND4SOCIAL: 2,
  VIRALITYFILMS: 3,
  COMPANY4_RECRUITING: 4
});

function getSelectedAnalysisPolicy(companyId) {
  const id = Number(companyId);

  if (id === COMPANY_IDS.BRAND4SOCIAL) {
    return {
      key: "brand4social",
      enabled: true,
      maxLeads: 20,
      requiresCallApproval: false,
      allowedStatuses: ["hubspot_imported", "new", "no_email", "ready", "contact_confirmed"],
      webhookUrl: N8N_B4S_WF02_SELECTED_WEBHOOK_URL
    };
  }

  if (id === COMPANY_IDS.VIRALITYFILMS) {
    return {
      key: "viralityfilms",
      enabled: true,
      maxLeads: 50,
      requiresCallApproval: true,
      allowedStatuses: ["new", "no_email", "contact_confirmed", "ready_for_analysis", "called", "approved", "ready"],
      webhookUrl: process.env.N8N_VF_WF02_ANALYSIS_WEBHOOK_URL || process.env.N8N_VF_WF02_WEBHOOK_URL || ""
    };
  }

  if (id === COMPANY_IDS.COMPANY4_RECRUITING) {
    return {
      key: "company4_recruiting",
      enabled: true,
      maxLeads: 750,
      videoLimit: 250,
      emailOnlyLimit: 500,
      requiresCallApproval: false,
      creditsMode: "video_only",
      allowedStatuses: ["new", "no_email", "ready", "enriched", "contact_confirmed"],
      webhookUrl: N8N_C4_WF02_SELECTED_WEBHOOK_URL
    };
  }

  return {
    key: "unsupported",
    enabled: false,
    maxLeads: 0,
    requiresCallApproval: false,
    allowedStatuses: [],
    webhookUrl: ""
  };
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "client-acquisition-api" });
});

app.get("/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ healthy: true, database: true, time: result.rows[0].now });
  } catch (error) {
    res.status(500).json({ healthy: false, database: false, error: error.message });
  }
});

app.get("/companies", checkJwt, async (req, res) => {
  try {
    const companyId = getCompanyId(req);

    if (!companyId) {
      return res.status(400).json({ error: "Keine company_id im Token gefunden." });
    }

    const result = await pool.query(
      `SELECT id, company_name, plan, plan_credits,
              credits_total, credits_used,
              (credits_total - credits_used) AS credits_remaining,
              next_reset, status, primary_color, secondary_color,
              logo_url, favicon_url, prompt_profile, created_at,
              COALESCE(features, '{}'::jsonb) AS features
       FROM companies
       WHERE id = $1`,
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Company nicht gefunden." });
    }

    res.json(result.rows);
  } catch (error) {
    console.error("[companies]", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/credits/check", checkJwt, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) {
      return res.status(400).json({ error: "company_id fehlt" });
    }

    const result = await pool.query(
      `SELECT credits_total, credits_used,
              (credits_total - credits_used) AS credits_remaining,
              plan, plan_credits, next_reset
       FROM companies WHERE id = $1`,
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Company nicht gefunden" });
    }

    const row = result.rows[0];
    return res.json({
      credits_total: row.credits_total,
      credits_used: row.credits_used,
      credits_remaining: row.credits_remaining,
      plan: row.plan,
      plan_credits: row.plan_credits,
      next_reset: row.next_reset,
      can_scan: row.credits_remaining > 0
    });
  } catch (err) {
    console.error("[credits/check]", err.message);
    return res.status(500).json({ error: "Interner Fehler" });
  }
});

app.post("/credits/use", async (req, res) => {
  const internalKey = req.headers["x-internal-key"];
  if (!internalKey || internalKey !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Nicht autorisiert" });
  }

  try {
    const { company_id, scan_id, lead_id } = req.body;
    if (!company_id) {
      return res.status(400).json({ error: "company_id fehlt" });
    }

    const check = await pool.query(
      "SELECT credits_total, credits_used FROM companies WHERE id = $1",
      [company_id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: "Company nicht gefunden" });
    }

    const { credits_total, credits_used } = check.rows[0];
    const remaining = credits_total - credits_used;

    if (remaining <= 0) {
      return res.status(402).json({
        error: "Keine Credits mehr verfügbar",
        credits_remaining: 0
      });
    }

    await pool.query(
      "UPDATE companies SET credits_used = credits_used + 1 WHERE id = $1",
      [company_id]
    );

    await pool.query(
      `INSERT INTO credit_logs (company_id, action, amount, scan_id, lead_id, note)
       VALUES ($1, 'used', 1, $2, $3, 'Automatisch durch n8n Workflow')`,
      [company_id, scan_id || null, lead_id || null]
    );

    return res.json({ success: true, credits_remaining: remaining - 1 });
  } catch (err) {
    console.error("[credits/use]", err.message);
    return res.status(500).json({ error: "Interner Fehler" });
  }
});

app.post("/credits/add", async (req, res) => {
  const internalKey = req.headers["x-internal-key"];
  if (!internalKey || internalKey !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Nicht autorisiert" });
  }

  try {
    const { company_id, amount, note } = req.body;
    if (!company_id || !amount || amount <= 0) {
      return res.status(400).json({ error: "company_id und amount (>0) erforderlich" });
    }

    await pool.query(
      "UPDATE companies SET credits_total = credits_total + $1 WHERE id = $2",
      [amount, company_id]
    );

    await pool.query(
      "INSERT INTO credit_logs (company_id, action, amount, note) VALUES ($1, 'added', $2, $3)",
      [company_id, amount, note || "Manuell hinzugefügt"]
    );

    const updated = await pool.query(
      "SELECT credits_total, credits_used FROM companies WHERE id = $1",
      [company_id]
    );

    return res.json({
      success: true,
      credits_total: updated.rows[0].credits_total,
      credits_remaining: updated.rows[0].credits_total - updated.rows[0].credits_used
    });
  } catch (err) {
    console.error("[credits/add]", err.message);
    return res.status(500).json({ error: "Interner Fehler" });
  }
});

app.get("/credits/log", checkJwt, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const limit = parsePositiveInt(req.query.limit, 50, 200);

    if (!companyId) {
      return res.status(400).json({ error: "company_id fehlt" });
    }

    const result = await pool.query(
      `SELECT cl.id, cl.action, cl.amount, cl.scan_id, cl.lead_id,
              cl.note, cl.created_at, l.lead_name
       FROM credit_logs cl
       LEFT JOIN leads l ON l.id = cl.lead_id
       WHERE cl.company_id = $1
       ORDER BY cl.created_at DESC
       LIMIT $2`,
      [companyId, limit]
    );

    return res.json({ logs: result.rows, total: result.rows.length });
  } catch (err) {
    console.error("[credits/log]", err.message);
    return res.status(500).json({ error: "Interner Fehler" });
  }
});

app.post("/credits/reset-all", async (req, res) => {
  const secret = req.headers["x-reset-secret"];
  if (!secret || secret !== RESET_SECRET) {
    return res.status(401).json({ error: "Nicht autorisiert" });
  }

  try {
    await pool.query(`
      UPDATE companies
      SET credits_used = 0,
          credits_total = plan_credits,
          next_reset = NOW() + INTERVAL '1 month'
    `);

    await pool.query(`
      INSERT INTO credit_logs (company_id, action, amount, note)
      SELECT id, 'reset', plan_credits, 'Monatlicher Reset'
      FROM companies
    `);

    return res.json({ success: true, message: "Alle Credits zurückgesetzt" });
  } catch (err) {
    console.error("[credits/reset-all]", err.message);
    return res.status(500).json({ error: "Interner Fehler" });
  }
});

app.get("/scans", checkJwt, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const limit = parsePositiveInt(req.query.limit, 50, 200);

    let query = `
      SELECT id, company_id, industry, region, lead_limit, status,
             total_found, total_processed, total_inserted, total_failed,
             error_message, started_at, finished_at, created_at
      FROM scans
    `;
    const params = [];

    if (companyId) {
      query += " WHERE company_id = $1";
      params.push(companyId);
    }

    query += ` ORDER BY id DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("[scans]", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/scans/:id", checkJwt, async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);

    const result = await pool.query(
      `SELECT id, company_id, industry, region, lead_limit, status,
              total_found, total_processed, total_inserted, total_failed,
              error_message, started_at, finished_at, created_at
       FROM scans
       WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Scan not found" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("[scans/:id]", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/scans", checkJwt, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const { industry, region, lead_limit } = req.body;

    if (!companyId || !industry || !region || !lead_limit) {
      return res.status(400).json({
        error: "industry, region und lead_limit sind erforderlich"
      });
    }

    const creditCheck = await pool.query(
      "SELECT credits_total, credits_used, (credits_total - credits_used) AS credits_remaining FROM companies WHERE id = $1",
      [companyId]
    );

    if (creditCheck.rows.length === 0) {
      return res.status(404).json({ error: "Company nicht gefunden" });
    }

    const { credits_remaining } = creditCheck.rows[0];

    if (credits_remaining <= 0) {
      return res.status(402).json({
        error: "Keine Credits verfügbar. Bitte warte bis zum nächsten Reset.",
        credits_remaining: 0,
        can_scan: false
      });
    }

    const effectiveLimit = Math.min(parseInt(lead_limit, 10), parseInt(credits_remaining, 10));

    const insertResult = await pool.query(
      `INSERT INTO scans (company_id, industry, region, lead_limit, status, created_at)
       VALUES ($1, $2, $3, $4, 'queued', NOW()) RETURNING *`,
      [companyId, industry, region, effectiveLimit]
    );

    const newScan = insertResult.rows[0];

    let webhookResult = { sent: false };
    const isVFScan = Number(companyId) === COMPANY_IDS.VIRALITYFILMS;

    if (isVFScan) {
      const minEmployees = parsePositiveInt(req.body.min_employees, 51, 100000);
      const maxEmployees = parsePositiveInt(req.body.max_employees, 200, 100000);
      const cityOverride = String(req.body.city || "").trim();
      const source = String(req.body.source || "apollo_outscraper").trim();
      const vfScanUrl =
        process.env.N8N_VF_SCAN_WEBHOOK_URL ||
        `${N8N_BASE}/vf-maps-scraper`;

      if (minEmployees > maxEmployees) {
        await pool.query(
          "UPDATE scans SET status = 'failed', error_message = $1 WHERE id = $2 AND company_id = $3",
          ["min_employees darf nicht größer als max_employees sein", newScan.id, companyId]
        ).catch(() => {});
        return res.status(400).json({
          error: "Mitarbeiter (von) darf nicht größer als Mitarbeiter (bis) sein."
        });
      }

      const payload = {
        scan_id: newScan.id,
        company_id: COMPANY_IDS.VIRALITYFILMS,
        industry: newScan.industry,
        region: newScan.region,
        city: cityOverride || null,
        lead_limit: newScan.lead_limit,
        min_employees: minEmployees,
        max_employees: maxEmployees,
        source
      };

      try {
        const webhookResponse = await safeFetch(vfScanUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const responseText = await webhookResponse.text();

        if (!webhookResponse.ok) {
          await pool.query(
            "UPDATE scans SET status = 'failed' WHERE id = $1 AND company_id = $2",
            [newScan.id, companyId]
          ).catch(() => {});
          return res.status(502).json({
            error: "Company-3-Workflow konnte nicht gestartet werden.",
            workflow_status: webhookResponse.status,
            details: responseText.slice(0, 1000)
          });
        }

        webhookResult = {
          sent: true,
          status: webhookResponse.status,
          mode: "vf-maps-scraper"
        };
      } catch (webhookError) {
        await pool.query(
          "UPDATE scans SET status = 'failed' WHERE id = $1 AND company_id = $2",
          [newScan.id, companyId]
        ).catch(() => {});
        return res.status(502).json({
          error: "Company-3-Workflow ist nicht erreichbar.",
          details: webhookError.message
        });
      }
    } else {
      const webhookUrl = N8N_SCAN_WEBHOOK_URL || `${N8N_BASE}/scan-start`;
      if (webhookUrl) {
        try {
          const webhookResponse = await safeFetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              scan_id: newScan.id,
              company_id: newScan.company_id,
              industry: newScan.industry,
              region: newScan.region,
              lead_limit: newScan.lead_limit
            })
          });
          webhookResult = { sent: true, status: webhookResponse.status };
        } catch (webhookError) {
          webhookResult = { sent: false, error: webhookError.message };
        }
      }
    }

    res.status(201).json({
      scan: newScan,
      webhook: webhookResult,
      credits_remaining
    });
  } catch (error) {
    console.error("[scans post]", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/scan/start", checkJwt, async (req, res) => {
  req.url = "/scans";
  app._router.handle(req, res, () => {});
});

app.post("/analysis/start-selected", checkJwt, async (req, res) => {
  try {
    const companyId = getCompanyId(req);

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Keine company_id im Token gefunden."
      });
    }

    const { lead_ids, requested_by } = req.body;

    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Keine Leads ausgewählt."
      });
    }

    const uniqueLeadIds = [...new Set(lead_ids.map(Number).filter(Boolean))];

    if (uniqueLeadIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Keine gültigen Lead-IDs übergeben."
      });
    }

    const companyResult = await pool.query(
      `SELECT id, company_name, credits_total, credits_used,
              (credits_total - credits_used) AS credits_remaining,
              COALESCE(features, '{}'::jsonb) AS features
       FROM companies
       WHERE id = $1`,
      [companyId]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Company nicht gefunden."
      });
    }

    const company = companyResult.rows[0];
    const policy = getSelectedAnalysisPolicy(companyId);
    const isVFCompany = policy.key === "viralityfilms";

    if (!policy.enabled) {
      return res.status(403).json({
        success: false,
        message: "Ausgewählte Analyse ist für diese Company nicht aktiviert."
      });
    }

    if (uniqueLeadIds.length > policy.maxLeads) {
      return res.status(400).json({
        success: false,
        message: `Bitte maximal ${policy.maxLeads} Leads pro Analyse-Run auswählen.`
      });
    }

    const selectedSplit = getSelectedLeadSplit(policy, uniqueLeadIds);
    const creditsToUse = selectedSplit.creditsToUse;

    if (Number(company.credits_remaining) < creditsToUse) {
      return res.status(400).json({
        success: false,
        message: `Nicht genug Credits. Verfügbar: ${company.credits_remaining}, benötigt: ${creditsToUse}.`
      });
    }

    const leadsResult = await pool.query(
      `SELECT id, status, call_approved, email, final_email, findymail_email
       FROM leads
       WHERE company_id = $1
         AND id = ANY($2::int[])`,
      [companyId, uniqueLeadIds]
    );

    const foundIds = leadsResult.rows.map(row => Number(row.id));
    const missingIds = uniqueLeadIds.filter(id => !foundIds.includes(id));

    if (missingIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Einige Leads wurden nicht gefunden oder gehören nicht zu dieser Company.",
        missing_ids: missingIds
      });
    }

    // Ausschließlich Company 3 / Viralityfilms:
    // telefonische Freigabe + E-Mail sind zwingend erforderlich.
    if (policy.requiresCallApproval) {
      const notApproved = leadsResult.rows.filter(row =>
        row.call_approved !== true || !(row.email || row.final_email || row.findymail_email)
      );
      if (notApproved.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Einige Leads haben keine Anruf-Freigabe oder fehlende E-Mail. Bitte erst freigeben.",
          not_approved_ids: notApproved.map(r => r.id)
        });
      }
    }

    const invalidLeads = leadsResult.rows.filter(row => !policy.allowedStatuses.includes(row.status));

    if (invalidLeads.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Einige Leads können nicht analysiert werden, weil sie bereits verarbeitet werden oder abgeschlossen sind.",
        invalid_leads: invalidLeads
      });
    }

    // Kein Fallback zwischen Kunden-Workflows:
    // Jeder Tenant verwendet ausschließlich seinen eigenen Webhook.
    const selectedWebhookUrl = policy.webhookUrl;

    if (!selectedWebhookUrl) {
      return res.status(500).json({
        success: false,
        message: "Webhook-URL fehlt im Backend."
      });
    }

    const requestedByValue = requested_by || getUserEmail(req) || "dashboard";
    const requests = [];
    const chunkSize = policy.webhookChunkSize || 50;

    if (policy.key === "company4_recruiting") {
      const selectionBatchId = `c4_dashboard_${Date.now()}`;

      for (const leadIds of chunkArray(selectedSplit.videoLeadIds, chunkSize)) {
        requests.push({
          company_id: companyId,
          lead_ids: leadIds,
          lead_typ: "video",
          skip_credits: false,
          requested_by: requestedByValue,
          selection_batch_id: selectionBatchId
        });
      }

      for (const leadIds of chunkArray(selectedSplit.emailOnlyLeadIds, chunkSize)) {
        requests.push({
          company_id: companyId,
          lead_ids: leadIds,
          lead_typ: "email_only",
          skip_credits: true,
          requested_by: requestedByValue,
          selection_batch_id: selectionBatchId
        });
      }
    } else {
      requests.push({
        company_id: companyId,
        lead_ids: uniqueLeadIds,
        requested_by: requestedByValue
      });
    }

    const startedRuns = [];

    for (const payload of requests) {
      const webhookRes = await safeFetch(selectedWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-token": N8N_INTERNAL_TOKEN
        },
        body: JSON.stringify(payload)
      });

      if (!webhookRes.ok) {
        const text = await webhookRes.text();

        return res.status(500).json({
          success: false,
          message: "WF02 konnte nicht gestartet werden.",
          failed_payload: payload,
          details: text
        });
      }

      startedRuns.push({
        lead_typ: payload.lead_typ || policy.key,
        count: payload.lead_ids.length,
        status: webhookRes.status
      });
    }

    return res.json({
      success: true,
      queued_count: uniqueLeadIds.length,
      lead_ids: uniqueLeadIds,
      video_count: selectedSplit.videoLeadIds.length,
      email_only_count: selectedSplit.emailOnlyLeadIds.length,
      credits_to_use: creditsToUse,
      runs_started: startedRuns,
      analysis_profile: policy.key
    });
  } catch (error) {
    console.error("analysis/start-selected error:", error);

    return res.status(500).json({
      success: false,
      message: "Interner Fehler beim Starten der Analyse.",
      error: error.message
    });
  }
});

app.get("/leads", checkJwt, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const limit = parsePositiveInt(req.query.limit, 200, 500);
    const page = parsePositiveInt(req.query.page, 1);
    const offset = (page - 1) * limit;
    const scan_id = req.query.scan_id;

    let where = [];
    let params = [];

    if (companyId) {
      where.push(`company_id = $${params.length + 1}`);
      params.push(companyId);
    }

    if (scan_id) {
      where.push(`scan_id = $${params.length + 1}`);
      params.push(scan_id);
    }

    const whereStr = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT
        id, company_id, scan_id, lead_name, lead_name AS company_name, industry, region, website,
        instagram_status, ads_status, ads_found, ads_score, ads_count, ads_active_count,
        website_score, opportunity_score, priority, sales_hook, final_sales_hook,
        audit_summary, marketing_analysis, compliment,
        weakness_tags, recommended_services, recommended_channel, score_breakdown,
        channel, status, crm_status, notes,
        crm_owner AS owner, crm_next_step AS next_step, crm_follow_up AS follow_up,
        call_approved, call_notes,
        email, phone, contact_person, managing_director,
        inhaber_vorname, inhaber_nachname,
        findymail_email, findymail_status,
        imprint_url, legal_form, street, postal_code, city,
        vat_id, commercial_register, contact_confidence,
        pagespeed_score, mobile_score, seo_score, website_quality, website_notes,
        instagram_url, instagram_handle, instagram_found,
        instagram_followers, instagram_last_post_days, instagram_posts_count,
        instagram_score, instagram_activity_status, instagram_notes,
        jobs_found, jobs_count, jobs_titles, jobs_score, jobs_status, jobs_notes,
        video_status, video_url, thumbnail_url,
        pitchlane_video_id, pitchlane_video_url, pitchlane_status,
        pitchlane_video_opened, pitchlane_video_started, pitchlane_video_finished,
        pitchlane_video_view_count, pitchlane_video_start_count, pitchlane_video_finish_count,
        pitchlane_first_opened_at, pitchlane_last_opened_at,
        pitchlane_first_started_at, pitchlane_last_started_at,
        pitchlane_first_finished_at, pitchlane_last_finished_at,
        pitchlane_hot_lead, pitchlane_engagement_status,
        final_email, final_email_type,
        analysis_requested_at, analysis_started_at, analysis_batch_id, analysis_requested_by,
        instantly_lead_id, instantly_campaign_id,
        outreach_status, outreach_sent_at, outreach_completed_at,
        impressum_fetch_status, impressum_extraction_status,
        created_at, updated_at
       FROM leads
       ${whereStr}
       ORDER BY opportunity_score DESC NULLS LAST, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Leads error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/leads/stats", checkJwt, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const where = companyId ? "WHERE company_id = $1" : "";
    const params = companyId ? [companyId] : [];

    const result = await pool.query(
      `SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN contact_person IS NOT NULL OR managing_director IS NOT NULL THEN 1 END) AS asp_found,
        COUNT(CASE WHEN findymail_email IS NOT NULL OR email IS NOT NULL OR final_email IS NOT NULL THEN 1 END) AS email_found,
        COUNT(CASE WHEN priority = 'A' THEN 1 END) AS a_leads,
        ROUND(AVG(opportunity_score)) AS avg_score,
        COUNT(CASE WHEN video_status IN ('completed', 'ready') OR video_url IS NOT NULL THEN 1 END) AS videos,
        COUNT(CASE WHEN outreach_status IN ('sent', 'active', 'email_sent', 'email_opened', 'email_clicked', 'replied') OR status = 'outreach_active' THEN 1 END) AS outreach_sent
       FROM leads ${where}`,
      params
    );

    const row = result.rows[0];
    res.json({
      total: parseInt(row.total, 10) || 0,
      asp_found: parseInt(row.asp_found, 10) || 0,
      email_found: parseInt(row.email_found, 10) || 0,
      a_leads: parseInt(row.a_leads, 10) || 0,
      avg_score: parseInt(row.avg_score, 10) || 0,
      videos: parseInt(row.videos, 10) || 0,
      outreach_sent: parseInt(row.outreach_sent, 10) || 0
    });
  } catch (error) {
    console.error("[leads/stats]", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/leads/reminders/due", checkJwt, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (![COMPANY_IDS.VIRALITYFILMS, COMPANY_IDS.COMPANY4_RECRUITING].includes(Number(companyId))) {
      return res.json([]);
    }

    const result = await pool.query(
      `SELECT id, lead_name,
              crm_next_step AS next_step,
              crm_follow_up AS follow_up
       FROM leads
       WHERE company_id = $1
         AND crm_follow_up IS NOT NULL
         AND crm_follow_up <= NOW()
         AND crm_reminded_at IS NULL
         AND (crm_snoozed_until IS NULL OR crm_snoozed_until <= NOW())
       ORDER BY crm_follow_up ASC
       LIMIT 10`,
      [companyId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("[leads/reminders/due]", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/leads/:id/reminder-ack", checkJwt, async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);
    const action = String(req.body?.action || "done");
    if (!["done", "open", "snooze"].includes(action)) {
      return res.status(400).json({ error: "Ungültige Erinnerungsaktion." });
    }

    const result = await pool.query(
      `UPDATE leads
       SET crm_reminded_at = CASE WHEN $3 = 'snooze' THEN NULL ELSE NOW() END,
           crm_snoozed_until = CASE
             WHEN $3 = 'snooze' THEN NOW() + INTERVAL '15 minutes'
             ELSE NULL
           END,
           updated_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING id, crm_follow_up AS follow_up,
                 crm_reminded_at, crm_snoozed_until`,
      [id, companyId, action]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Lead not found" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("[leads/:id/reminder-ack]", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/leads/:id", checkJwt, async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);

    const leadResult = await pool.query(
      `SELECT *,
              crm_owner AS owner,
              crm_next_step AS next_step,
              crm_follow_up AS follow_up
       FROM leads
       WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );

    if (leadResult.rows.length === 0) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const auditResult = await pool.query(
      "SELECT * FROM audits WHERE lead_id = $1 ORDER BY id DESC LIMIT 1",
      [id]
    );

    res.json({ ...leadResult.rows[0], audit: auditResult.rows[0] || null });
  } catch (error) {
    console.error("[leads/:id]", error);
    res.status(500).json({ error: error.message });
  }
});

app.patch("/leads/:id", checkJwt, async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);
    const {
      status, notes,
      call_approved, call_notes,
      email, phone,
      contact_person, managing_director,
      lead_name, crm_status,
      owner, next_step, follow_up
    } = req.body;
    const isViralityFilmsCompany = Number(companyId) === COMPANY_IDS.VIRALITYFILMS;
    const supportsSalesCrm = [
      COMPANY_IDS.VIRALITYFILMS,
      COMPANY_IDS.COMPANY4_RECRUITING
    ].includes(Number(companyId));
    const hasOwner = Object.prototype.hasOwnProperty.call(req.body, "owner");
    const hasNextStep = Object.prototype.hasOwnProperty.call(req.body, "next_step");
    const hasFollowUp = Object.prototype.hasOwnProperty.call(req.body, "follow_up");
    const hasCrmStatus = Object.prototype.hasOwnProperty.call(req.body, "crm_status");
    const shouldSyncManualEmail = isViralityFilmsCompany &&
      Object.prototype.hasOwnProperty.call(req.body, "email");

    if (supportsSalesCrm && crm_status != null) {
      const allowedStatuses = new Set([
        "analyzed", "follow_up", "meeting", "won", "lost", "existing_customer", "no_interest"
      ]);
      if (!allowedStatuses.has(String(crm_status))) {
        return res.status(400).json({ error: "Ungültiger CRM-Status." });
      }
    }

    const previousLeadResult = await pool.query(
      "SELECT id, call_approved FROM leads WHERE id = $1 AND company_id = $2",
      [id, companyId]
    );

    if (previousLeadResult.rows.length === 0) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const previousLead = previousLeadResult.rows[0];

    // inhaber_vorname/nachname aus contact_person ableiten wenn geaendert
    let inhaber_vorname = null;
    let inhaber_nachname = null;
    if (contact_person) {
      const parts = contact_person.trim().split(/\s+/).filter(Boolean);
      inhaber_vorname = parts[0] || null;
      inhaber_nachname = parts.slice(1).join(' ') || null;
    }

    const result = await pool.query(
      `UPDATE leads
       SET status            = COALESCE($1, status),
           notes             = COALESCE($2, notes),
           call_approved     = COALESCE($3, call_approved),
           call_notes        = COALESCE($4, call_notes),
           email             = COALESCE($5, email),
           phone             = COALESCE($6, phone),
           contact_person    = COALESCE($7, contact_person),
           managing_director = COALESCE($8, managing_director),
           lead_name         = COALESCE($9, lead_name),
           inhaber_vorname   = CASE WHEN $7::text IS NOT NULL THEN $10::text ELSE inhaber_vorname END,
           inhaber_nachname  = CASE WHEN $7::text IS NOT NULL THEN $11::text ELSE inhaber_nachname END,
           crm_owner         = CASE WHEN $19::boolean THEN NULLIF($12::text, '') ELSE crm_owner END,
           crm_next_step     = CASE WHEN $20::boolean THEN NULLIF($13::text, '') ELSE crm_next_step END,
           crm_follow_up     = CASE
                                 WHEN $21::boolean THEN NULLIF($14::text, '')::timestamptz
                                 ELSE crm_follow_up
                               END,
           crm_reminded_at   = CASE WHEN $21::boolean THEN NULL ELSE crm_reminded_at END,
           crm_snoozed_until = CASE WHEN $21::boolean THEN NULL ELSE crm_snoozed_until END,
           crm_status        = CASE WHEN $22::boolean THEN $23::text ELSE crm_status END,
           final_email       = CASE WHEN $17::boolean THEN NULLIF($18::text, '') ELSE final_email END,
           final_email_type  = CASE
                                 WHEN $17::boolean THEN
                                   CASE WHEN NULLIF($18::text, '') IS NULL THEN NULL ELSE 'manual' END
                                 ELSE final_email_type
                               END,
           updated_at        = NOW()
       WHERE id = $15 AND company_id = $16
       RETURNING id, lead_name, status, crm_status, notes,
                 crm_owner AS owner,
                 crm_next_step AS next_step,
                 crm_follow_up AS follow_up,
                 call_approved, call_notes,
                 email, phone, contact_person, managing_director,
                 inhaber_vorname, inhaber_nachname,
                 final_email, final_email_type,
                 updated_at`,
      [
        status ?? null,
        notes ?? null,
        call_approved ?? null,
        call_notes ?? null,
        email ?? null,
        phone ?? null,
        contact_person ?? null,
        managing_director ?? null,
        lead_name ?? null,
        inhaber_vorname,
        inhaber_nachname,
        owner ?? null,
        next_step ?? null,
        follow_up ?? null,
        id,
        companyId,
        shouldSyncManualEmail,
        email ?? null,
        hasOwner,
        hasNextStep,
        hasFollowUp,
        hasCrmStatus,
        crm_status ?? null
      ]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Lead not found" });

    const updatedLead = result.rows[0];

    // VF: Wenn call_approved auf TRUE gesetzt wird → WF02b automatisch triggern
    if (isViralityFilmsCompany &&
        call_approved === true &&
        updatedLead.call_approved === true &&
        previousLead.call_approved !== true) {
      const vfPitchlaneUrl = process.env.N8N_VF_WF02B_WEBHOOK_URL || "";
      if (vfPitchlaneUrl) {
        safeFetch(vfPitchlaneUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-token": N8N_INTERNAL_TOKEN
          },
          body: JSON.stringify({
            lead_id: Number(id),
            company_id: COMPANY_IDS.VIRALITYFILMS,
            lead_name: updatedLead.lead_name,
            contact_person: updatedLead.contact_person,
            email: updatedLead.email || updatedLead.final_email,
            phone: updatedLead.phone,
            triggered_by: getUserEmail(req) || "dashboard"
          })
        }).catch(e => console.error("[vf wf02b auto-trigger]", e.message));
      }
    }

    res.json(updatedLead);
  } catch (error) {
    console.error("[leads patch]", error);
    res.status(500).json({ error: error.message });
  }
});

// VF: Manueller Pitchlane+Instantly Start (Fallback)
app.post("/pitchlane/start", checkJwt, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (Number(companyId) !== COMPANY_IDS.VIRALITYFILMS) {
      return res.status(403).json({ success: false, message: "Nur für Viralityfilms verfügbar." });
    }
    const { lead_id } = req.body;
    if (!lead_id) return res.status(400).json({ success: false, message: "lead_id fehlt." });

    const leadResult = await pool.query(
      "SELECT id, call_approved, email, status FROM leads WHERE id = $1 AND company_id = $2",
      [lead_id, companyId]
    );
    if (leadResult.rows.length === 0) return res.status(404).json({ success: false, message: "Lead nicht gefunden." });
    const lead = leadResult.rows[0];
    if (!lead.call_approved) return res.status(400).json({ success: false, message: "Lead hat keine telefonische Freigabe." });
    if (!lead.email) return res.status(400).json({ success: false, message: "Keine E-Mail-Adresse hinterlegt." });

    const vfPitchlaneUrl = process.env.N8N_VF_WF02B_WEBHOOK_URL || "";
    if (!vfPitchlaneUrl) return res.status(500).json({ success: false, message: "Pitchlane-Webhook-URL fehlt." });

    const webhookRes = await safeFetch(vfPitchlaneUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": N8N_INTERNAL_TOKEN },
      body: JSON.stringify({ lead_id: Number(lead_id), company_id: companyId, triggered_by: getUserEmail(req) })
    });

    if (!webhookRes.ok) {
      const text = await webhookRes.text();
      return res.status(500).json({ success: false, message: "Pitchlane-Start fehlgeschlagen.", details: text });
    }

    return res.json({ success: true, lead_id: Number(lead_id), message: "Pitchlane+Instantly gestartet." });
  } catch (error) {
    console.error("[pitchlane/start]", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/audits", checkJwt, async (req, res) => {
  try {
    const lead_id = req.query.lead_id;
    const companyId = getCompanyId(req);

    if (lead_id) {
      const result = await pool.query(
        `SELECT a.id, a.lead_id, a.audit_summary, a.audit_html, a.pdf_url, a.created_at
         FROM audits a
         JOIN leads l ON l.id = a.lead_id
         WHERE a.lead_id = $1 AND l.company_id = $2
         ORDER BY a.id DESC
         LIMIT 50`,
        [lead_id, companyId]
      );
      return res.json(result.rows);
    }

    const result = await pool.query(
      `SELECT a.id, a.lead_id, a.audit_summary, a.audit_html, a.pdf_url, a.created_at
       FROM audits a
       JOIN leads l ON l.id = a.lead_id
       WHERE l.company_id = $1
       ORDER BY a.id DESC
       LIMIT 50`,
      [companyId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("[audits]", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/leads/:id/video-complete", async (req, res) => {
  try {
    const { id } = req.params;
    const { video_url, thumbnail_url, video_id, pitchlane_video_id } = req.body;

    const result = await pool.query(
      `UPDATE leads
       SET video_status = 'completed',
           video_url = COALESCE($1, video_url),
           thumbnail_url = COALESCE($2, thumbnail_url),
           pitchlane_video_id = COALESCE($3, pitchlane_video_id),
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, lead_name, video_url, thumbnail_url, pitchlane_video_id, video_status`,
      [video_url || null, thumbnail_url || null, pitchlane_video_id || video_id || null, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Lead not found" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("[video-complete]", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`API laeuft auf Port ${PORT}`);
});
