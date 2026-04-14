const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const N8N_SCAN_WEBHOOK_URL = process.env.N8N_SCAN_WEBHOOK_URL || "";
const N8N_BASE = process.env.N8N_BASE_URL || "https://automatisierung.automatisierungen-ki.de/webhook";
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "";
const RESET_SECRET = process.env.RESET_SECRET || "";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// COMPANIES
// ─────────────────────────────────────────────────────────────
app.get("/companies", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, company_name, plan, plan_credits,
             credits_total, credits_used,
             (credits_total - credits_used) AS credits_remaining,
             next_reset, status, primary_color, secondary_color,
             logo_url, prompt_profile, created_at
      FROM companies ORDER BY id ASC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// CREDITS – Check (Frontend ruft das vor Scan-Start auf)
// ─────────────────────────────────────────────────────────────
app.get("/credits/check", async (req, res) => {
  try {
    const companyId = req.query.company_id;
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
      credits_total:     row.credits_total,
      credits_used:      row.credits_used,
      credits_remaining: row.credits_remaining,
      plan:              row.plan,
      plan_credits:      row.plan_credits,
      next_reset:        row.next_reset,
      can_scan:          row.credits_remaining > 0
    });
  } catch (err) {
    console.error("[credits/check]", err.message);
    return res.status(500).json({ error: "Interner Fehler" });
  }
});

// ─────────────────────────────────────────────────────────────
// CREDITS – Use (n8n ruft das nach jedem Insert Lead auf)
// Gesichert mit x-internal-key Header
// ─────────────────────────────────────────────────────────────
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

    return res.json({
      success: true,
      credits_remaining: remaining - 1
    });
  } catch (err) {
    console.error("[credits/use]", err.message);
    return res.status(500).json({ error: "Interner Fehler" });
  }
});

// ─────────────────────────────────────────────────────────────
// CREDITS – Add (manuell nach Upgrade)
// ─────────────────────────────────────────────────────────────
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
      credits_total:     updated.rows[0].credits_total,
      credits_remaining: updated.rows[0].credits_total - updated.rows[0].credits_used
    });
  } catch (err) {
    console.error("[credits/add]", err.message);
    return res.status(500).json({ error: "Interner Fehler" });
  }
});

// ─────────────────────────────────────────────────────────────
// CREDITS – Log (Dashboard-Anzeige)
// ─────────────────────────────────────────────────────────────
app.get("/credits/log", async (req, res) => {
  try {
    const companyId = req.query.company_id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

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

// ─────────────────────────────────────────────────────────────
// CREDITS – Monatlicher Reset (per Coolify Scheduled Task
// oder manuell per API-Aufruf mit x-reset-secret Header)
// Coolify Cron: 0 0 1 * *
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// SCANS
// ─────────────────────────────────────────────────────────────
app.get("/scans", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const company_id = req.query.company_id;

    let query = `
      SELECT id, company_id, industry, region, lead_limit, status,
             total_found, total_processed, total_inserted, total_failed,
             error_message, started_at, finished_at, created_at
      FROM scans
    `;
    const params = [];

    if (company_id) {
      query += " WHERE company_id = $1";
      params.push(company_id);
    }

    query += ` ORDER BY id DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/scans/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT id, company_id, industry, region, lead_limit, status,
              total_found, total_processed, total_inserted, total_failed,
              error_message, started_at, finished_at, created_at
       FROM scans WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Scan not found" });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /scans – Scan anlegen + Credits prüfen + n8n triggern
app.post("/scans", async (req, res) => {
  try {
    const { company_id, industry, region, lead_limit } = req.body;

    if (!company_id || !industry || !region || !lead_limit) {
      return res.status(400).json({
        error: "company_id, industry, region und lead_limit sind erforderlich"
      });
    }

    // ── CREDIT CHECK vor dem Scan ────────────────────────────
    const creditCheck = await pool.query(
      "SELECT credits_total, credits_used, (credits_total - credits_used) AS credits_remaining FROM companies WHERE id = $1",
      [company_id]
    );

    if (creditCheck.rows.length === 0) {
      return res.status(404).json({ error: "Company nicht gefunden" });
    }

    const { credits_remaining } = creditCheck.rows[0];

    if (credits_remaining <= 0) {
      return res.status(402).json({
        error: "Keine Credits verfügbar. Bitte warte bis zum nächsten Reset oder buche ein Upgrade.",
        credits_remaining: 0,
        can_scan: false
      });
    }

    // Sicherstellen: lead_limit nicht größer als verfügbare Credits
    const effectiveLimit = Math.min(parseInt(lead_limit), parseInt(credits_remaining));

    // ── Scan in DB anlegen ───────────────────────────────────
    const insertResult = await pool.query(
      `INSERT INTO scans (company_id, industry, region, lead_limit, status, created_at)
       VALUES ($1, $2, $3, $4, 'queued', NOW()) RETURNING *`,
      [company_id, industry, region, effectiveLimit]
    );

    const newScan = insertResult.rows[0];

    // ── n8n Webhook triggern ─────────────────────────────────
    let webhookResult = { sent: false, status: null, error: null };
    const webhookUrl = N8N_SCAN_WEBHOOK_URL || `${N8N_BASE}/scan-start`;

    if (webhookUrl) {
      try {
        const webhookResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scan_id:    newScan.id,
            company_id: newScan.company_id,
            industry:   newScan.industry,
            region:     newScan.region,
            lead_limit: newScan.lead_limit,
          }),
        });
        webhookResult = { sent: true, status: webhookResponse.status };
      } catch (webhookError) {
        console.error("Webhook error:", webhookError);
        webhookResult = { sent: false, error: webhookError.message };
      }
    }

    res.status(201).json({
      scan: newScan,
      webhook: webhookResult,
      credits_remaining: credits_remaining  // Frontend kann direkt anzeigen
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy Endpoint
app.post("/scan/start", async (req, res) => {
  req.url = "/scans";
  app._router.handle(req, res, () => {});
});

// ─────────────────────────────────────────────────────────────
// LEADS
// ─────────────────────────────────────────────────────────────
app.get("/leads", async (req, res) => {
  try {
    const limit      = parseInt(req.query.limit) || 200;
    const page       = parseInt(req.query.page)  || 1;
    const offset     = (page - 1) * limit;
    const company_id = req.query.company_id;
    const scan_id    = req.query.scan_id;

    let where = [];
    let params = [];

    if (company_id) { where.push(`company_id = $${params.length + 1}`); params.push(company_id); }
    if (scan_id)    { where.push(`scan_id = $${params.length + 1}`);    params.push(scan_id); }

    const whereStr = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const result = await pool.query(
      `SELECT
        id, company_id, scan_id, lead_name, website,
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
        video_status, video_url, thumbnail_url,
        outreach_status, outreach_sent_at,
        impressum_fetch_status, impressum_extraction_status,
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

app.get("/leads/stats", async (req, res) => {
  try {
    const company_id = req.query.company_id;
    const where  = company_id ? "WHERE company_id = $1" : "";
    const params = company_id ? [company_id] : [];

    const result = await pool.query(
      `SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN contact_person IS NOT NULL OR managing_director IS NOT NULL THEN 1 END) AS asp_found,
        COUNT(CASE WHEN findymail_email IS NOT NULL OR email IS NOT NULL THEN 1 END) AS email_found,
        COUNT(CASE WHEN priority = 'A' THEN 1 END) AS a_leads,
        ROUND(AVG(opportunity_score)) AS avg_score,
        COUNT(CASE WHEN video_status = 'completed' THEN 1 END) AS videos,
        COUNT(CASE WHEN outreach_status = 'sent' THEN 1 END) AS outreach_sent
       FROM leads ${where}`,
      params
    );

    const row = result.rows[0];
    res.json({
      total:         parseInt(row.total)         || 0,
      asp_found:     parseInt(row.asp_found)     || 0,
      email_found:   parseInt(row.email_found)   || 0,
      a_leads:       parseInt(row.a_leads)       || 0,
      avg_score:     parseInt(row.avg_score)     || 0,
      videos:        parseInt(row.videos)        || 0,
      outreach_sent: parseInt(row.outreach_sent) || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/leads/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const leadResult = await pool.query(
      "SELECT * FROM leads WHERE id = $1", [id]
    );

    if (leadResult.rows.length === 0) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const auditResult = await pool.query(
      "SELECT * FROM audits WHERE lead_id = $1 ORDER BY id DESC LIMIT 1", [id]
    );

    res.json({ ...leadResult.rows[0], audit: auditResult.rows[0] || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/leads/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes, owner, next_step, follow_up } = req.body;

    const result = await pool.query(
      `UPDATE leads
       SET status = COALESCE($1, status),
           notes  = COALESCE($2, notes),
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, lead_name, status, notes, updated_at`,
      [status, notes, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Lead not found" });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// AUDITS
// ─────────────────────────────────────────────────────────────
app.get("/audits", async (req, res) => {
  try {
    const lead_id = req.query.lead_id;
    const where  = lead_id ? "WHERE lead_id = $1" : "";
    const params = lead_id ? [lead_id] : [];

    const result = await pool.query(
      `SELECT id, lead_id, audit_summary, audit_html, pdf_url, created_at
       FROM audits ${where} ORDER BY id DESC LIMIT 50`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// VIDEO – Pitchlane Callback
// ─────────────────────────────────────────────────────────────
app.post("/leads/:id/video-complete", async (req, res) => {
  try {
    const { id } = req.params;
    const { video_url, thumbnail_url, video_id } = req.body;

    const result = await pool.query(
      `UPDATE leads
       SET video_status = 'completed', video_url = $1,
           thumbnail_url = $2, video_id = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id, lead_name, video_url, video_status`,
      [video_url, thumbnail_url, video_id, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Lead not found" });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`API laeuft auf Port ${PORT}`);
});