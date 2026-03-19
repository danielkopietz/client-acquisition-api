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
      SELECT id, company_name, plan, credits_total, credits_used,
             status, primary_color, secondary_color, logo_url,
             prompt_profile, created_at
      FROM companies ORDER BY id ASC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
      query += ` WHERE company_id = $1`;
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

// POST /scans – Scan anlegen + n8n triggern (Dashboard nutzt diesen Endpoint)
app.post("/scans", async (req, res) => {
  try {
    const { company_id, industry, region, lead_limit } = req.body;

    if (!company_id || !industry || !region || !lead_limit) {
      return res.status(400).json({
        error: "company_id, industry, region und lead_limit sind erforderlich"
      });
    }

    const insertResult = await pool.query(
      `INSERT INTO scans (company_id, industry, region, lead_limit, status, created_at)
       VALUES ($1, $2, $3, $4, 'queued', NOW()) RETURNING *`,
      [company_id, industry, region, lead_limit]
    );

    const newScan = insertResult.rows[0];

    // n8n Webhook triggern
    let webhookResult = { sent: false, status: null, error: null };
    const webhookUrl = N8N_SCAN_WEBHOOK_URL || `${N8N_BASE}/scan-start`;

    if (webhookUrl) {
      try {
        const webhookResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scan_id: newScan.id,
            company_id: newScan.company_id,
            industry: newScan.industry,
            region: newScan.region,
            lead_limit: newScan.lead_limit,
          }),
        });
        webhookResult = { sent: true, status: webhookResponse.status };
      } catch (webhookError) {
        console.error("Webhook error:", webhookError);
        webhookResult = { sent: false, error: webhookError.message };
      }
    }

    res.status(201).json({ scan: newScan, webhook: webhookResult });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy Endpoint (alter Pfad, bleibt für Kompatibilität)
app.post("/scan/start", async (req, res) => {
  req.url = "/scans";
  app._router.handle(req, res, () => {});
});

// ─────────────────────────────────────────────────────────────
// LEADS
// ─────────────────────────────────────────────────────────────
app.get("/leads", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 200;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;
    const company_id = req.query.company_id;
    const scan_id = req.query.scan_id;

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
    const where = company_id ? `WHERE company_id = $1` : "";
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
      total: parseInt(row.total) || 0,
      asp_found: parseInt(row.asp_found) || 0,
      email_found: parseInt(row.email_found) || 0,
      a_leads: parseInt(row.a_leads) || 0,
      avg_score: parseInt(row.avg_score) || 0,
      videos: parseInt(row.videos) || 0,
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
      `SELECT * FROM leads WHERE id = $1`, [id]
    );

    if (leadResult.rows.length === 0) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const auditResult = await pool.query(
      `SELECT * FROM audits WHERE lead_id = $1 ORDER BY id DESC LIMIT 1`, [id]
    );

    res.json({
      ...leadResult.rows[0],
      audit: auditResult.rows[0] || null,
    });
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
           notes = COALESCE($2, notes),
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
    const where = lead_id ? "WHERE lead_id = $1" : "";
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
// VIDEO – Status aktualisieren (Pitchlane Callback via API)
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

app.listen(PORT, () => {
  console.log(`API laeuft auf Port ${PORT}`);
});