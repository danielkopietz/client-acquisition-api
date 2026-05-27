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
const N8N_INTERNAL_TOKEN = process.env.N8N_INTERNAL_TOKEN || "";
const N8N_VF_SCAN_WEBHOOK_URL = process.env.N8N_VF_SCAN_WEBHOOK_URL || `${N8N_BASE}/vf-maps-scraper`;
const N8N_VF_WF02_WEBHOOK_URL = process.env.N8N_VF_WF02_WEBHOOK_URL || `${N8N_BASE}/vf-run-selected-analysis`;

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

function cleanNullable(value) {
  if (value === undefined) return undefined;
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return clean || null;
}

function isValidEmail(value) {
  if (!value) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

function splitContactName(fullName) {
  const name = cleanNullable(fullName);
  if (!name) return { firstName: null, lastName: null };
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || null,
    lastName: parts.slice(1).join(" ") || null
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
    const industry = cleanNullable(req.body.industry);
    const region = cleanNullable(req.body.region);
    const leadLimit = parsePositiveInt(req.body.lead_limit, 5, 20);

    if (!companyId || !industry || !region) {
      return res.status(400).json({
        error: "Branche, Region und Lead Limit sind erforderlich."
      });
    }

    const insertResult = await pool.query(
      `INSERT INTO scans (company_id, industry, region, lead_limit, status, created_at)
       VALUES ($1, $2, $3, $4, 'queued', NOW())
       RETURNING *`,
      [companyId, industry, region, leadLimit]
    );

    const newScan = insertResult.rows[0];
    const isVFCompany = companyId === 3;
    const webhookUrl = isVFCompany
      ? N8N_VF_SCAN_WEBHOOK_URL
      : (N8N_SCAN_WEBHOOK_URL || `${N8N_BASE}/scan-start`);

    if (!webhookUrl) {
      await pool.query(
        "UPDATE scans SET status = 'failed', error_message = $1, finished_at = NOW() WHERE id = $2",
        ["Webhook-URL fehlt im Backend.", newScan.id]
      );
      return res.status(500).json({ error: "Webhook-URL fehlt im Backend." });
    }

    const webhookPayload = isVFCompany
      ? {
          scan_id: newScan.id,
          company_id: 3,
          industry: newScan.industry,
          region: newScan.region,
          lead_limit: newScan.lead_limit
        }
      : {
          scan_id: newScan.id,
          company_id: newScan.company_id,
          industry: newScan.industry,
          region: newScan.region,
          lead_limit: newScan.lead_limit
        };

    try {
      const webhookResponse = await safeFetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(N8N_INTERNAL_TOKEN ? { "x-internal-token": N8N_INTERNAL_TOKEN } : {})
        },
        body: JSON.stringify(webhookPayload)
      });

      if (!webhookResponse.ok) {
        const details = await webhookResponse.text().catch(() => "");
        await pool.query(
          "UPDATE scans SET status = 'failed', error_message = $1, finished_at = NOW() WHERE id = $2",
          [`WF01 antwortet mit HTTP ${webhookResponse.status}: ${details.slice(0, 300)}`, newScan.id]
        );
        return res.status(502).json({
          error: "WF01 konnte nicht gestartet werden.",
          status: webhookResponse.status
        });
      }

      return res.status(201).json({
        scan: newScan,
        webhook: { sent: true, status: webhookResponse.status, mode: isVFCompany ? "vf" : "default" }
      });
    } catch (webhookError) {
      await pool.query(
        "UPDATE scans SET status = 'failed', error_message = $1, finished_at = NOW() WHERE id = $2",
        [webhookError.message, newScan.id]
      );
      return res.status(502).json({
        error: "WF01 konnte nicht erreicht werden.",
        details: webhookError.message
      });
    }
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
    const { lead_ids, requested_by } = req.body;

    if (!companyId) {
      return res.status(400).json({ success: false, message: "Keine company_id im Token gefunden." });
    }

    const uniqueLeadIds = Array.isArray(lead_ids)
      ? [...new Set(lead_ids.map(Number).filter(id => Number.isInteger(id) && id > 0))]
      : [];

    if (!uniqueLeadIds.length) {
      return res.status(400).json({ success: false, message: "Keine Leads ausgewählt." });
    }

    if (uniqueLeadIds.length > 50) {
      return res.status(400).json({ success: false, message: "Bitte maximal 50 Leads pro Analyse-Run auswählen." });
    }

    const companyResult = await pool.query(
      `SELECT id, company_name, credits_total, credits_used,
              (credits_total - credits_used) AS credits_remaining,
              COALESCE(features, '{}'::jsonb) AS features
       FROM companies WHERE id = $1`,
      [companyId]
    );

    if (!companyResult.rows.length) {
      return res.status(404).json({ success: false, message: "Company nicht gefunden." });
    }

    const company = companyResult.rows[0];
    const isVFCompany = companyId === 3;

    if (!isVFCompany && company.features?.selected_analysis !== true) {
      return res.status(403).json({
        success: false,
        message: "Ausgewählte Analyse ist für diese Company nicht aktiviert."
      });
    }

    if (Number(company.credits_remaining) < uniqueLeadIds.length) {
      return res.status(400).json({
        success: false,
        message: `Nicht genug Credits. Verfügbar: ${company.credits_remaining}, ausgewählt: ${uniqueLeadIds.length}.`
      });
    }

    const leadsResult = await pool.query(
      `SELECT id, status, call_approved, email, contact_person
       FROM leads
       WHERE company_id = $1 AND id = ANY($2::int[])`,
      [companyId, uniqueLeadIds]
    );

    const foundIds = leadsResult.rows.map(row => Number(row.id));
    const missingIds = uniqueLeadIds.filter(id => !foundIds.includes(id));

    if (missingIds.length) {
      return res.status(400).json({
        success: false,
        message: "Einige Leads wurden nicht gefunden oder gehören nicht zu dieser Company.",
        missing_ids: missingIds
      });
    }

    if (isVFCompany) {
      const notReady = leadsResult.rows.filter(row =>
        row.call_approved !== true || !isValidEmail(row.email)
      );

      if (notReady.length) {
        return res.status(400).json({
          success: false,
          message: "Bitte vor der Analyse eine gültige E-Mail speichern und die telefonische Versandfreigabe aktivieren.",
          not_ready_ids: notReady.map(row => row.id)
        });
      }
    }

    const allowedStatuses = isVFCompany
      ? ["new", "no_email", "called", "approved", "contact_confirmed", "ready_for_analysis"]
      : ["hubspot_imported", "new", "no_email"];

    const invalidLeads = leadsResult.rows.filter(row => !allowedStatuses.includes(row.status || "new"));
    if (invalidLeads.length) {
      return res.status(400).json({
        success: false,
        message: "Einige Leads können in ihrem aktuellen Status nicht analysiert werden.",
        invalid_leads: invalidLeads.map(row => ({ id: row.id, status: row.status }))
      });
    }

    const selectedWebhookUrl = isVFCompany
      ? N8N_VF_WF02_WEBHOOK_URL
      : N8N_B4S_WF02_SELECTED_WEBHOOK_URL;

    if (!selectedWebhookUrl) {
      return res.status(500).json({ success: false, message: "WF02-Webhook-URL fehlt im Backend." });
    }

    const webhookRes = await safeFetch(selectedWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(N8N_INTERNAL_TOKEN ? { "x-internal-token": N8N_INTERNAL_TOKEN } : {})
      },
      body: JSON.stringify({
        company_id: companyId,
        lead_ids: uniqueLeadIds,
        requested_by: requested_by || getUserEmail(req)
      })
    });

    if (!webhookRes.ok) {
      const text = await webhookRes.text().catch(() => "");
      return res.status(502).json({
        success: false,
        message: "WF02 konnte nicht gestartet werden.",
        details: text.slice(0, 500)
      });
    }

    return res.json({
      success: true,
      queued_count: uniqueLeadIds.length,
      lead_ids: uniqueLeadIds,
      credits_to_use_after_completed_analysis: uniqueLeadIds.length,
      credits_are_deducted_now: false
    });
  } catch (error) {
    console.error("[analysis/start-selected]", error);
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
        channel, status, notes,
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
        video_status, video_url, thumbnail_url, pitchlane_video_id,
        final_email, final_email_type,
        analysis_requested_at, analysis_started_at, analysis_batch_id, analysis_requested_by,
        outreach_status, outreach_sent_at,
        impressum_fetch_status, impressum_extraction_status,
        call_approved, call_notes,
        created_at
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
        COUNT(CASE WHEN outreach_status IN ('sent', 'active') THEN 1 END) AS outreach_sent
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

app.get("/leads/:id", checkJwt, async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = getCompanyId(req);

    const leadResult = await pool.query(
      "SELECT * FROM leads WHERE id = $1 AND company_id = $2",
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
  const client = await pool.connect();

  try {
    const leadId = Number(req.params.id);
    const companyId = getCompanyId(req);

    if (!Number.isInteger(leadId) || !companyId) {
      return res.status(400).json({ error: "Ungültiger Lead oder Company-Kontext." });
    }

    const allowed = [
      "lead_name", "email", "phone", "contact_person",
      "call_approved", "call_notes", "notes", "status"
    ];
    const fields = [];
    const values = [];

    for (const field of allowed) {
      if (!Object.prototype.hasOwnProperty.call(req.body, field)) continue;

      let value = req.body[field];
      if (["lead_name", "email", "phone", "contact_person", "call_notes", "notes", "status"].includes(field)) {
        value = cleanNullable(value);
      }

      if (field === "email" && value && !isValidEmail(value)) {
        return res.status(400).json({ error: "Bitte eine gültige E-Mail-Adresse eingeben." });
      }

      if (field === "call_approved") {
        value = value === true;
      }

      values.push(value);
      fields.push(`${field} = $${values.length}`);
    }

    if (!fields.length) {
      return res.status(400).json({ error: "Keine bearbeitbaren Felder übergeben." });
    }

    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT * FROM leads WHERE id = $1 AND company_id = $2 FOR UPDATE",
      [leadId, companyId]
    );

    if (!existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Lead nicht gefunden." });
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "contact_person")) {
      const name = splitContactName(req.body.contact_person);
      values.push(name.firstName);
      fields.push(`inhaber_vorname = $${values.length}`);
      values.push(name.lastName);
      fields.push(`inhaber_nachname = $${values.length}`);
      values.push(cleanNullable(req.body.contact_person));
      fields.push(`managing_director = $${values.length}`);
    }

    values.push(leadId, companyId);
    await client.query(
      `UPDATE leads
       SET ${fields.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length - 1} AND company_id = $${values.length}`,
      values
    );

    const refreshed = await client.query(
      "SELECT * FROM leads WHERE id = $1 AND company_id = $2",
      [leadId, companyId]
    );
    let lead = refreshed.rows[0];

    if (companyId === 3 && ["new", "no_email", "called", "approved", "contact_confirmed", "ready_for_analysis"].includes(lead.status || "new")) {
      const nextStatus = lead.call_approved === true && isValidEmail(lead.email)
        ? "ready_for_analysis"
        : (lead.call_approved === true ? "no_email" : "new");

      const statusResult = await client.query(
        "UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3 RETURNING *",
        [nextStatus, leadId, companyId]
      );
      lead = statusResult.rows[0];
    }

    await client.query("COMMIT");
    return res.json(lead);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[leads patch]", error);
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
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
