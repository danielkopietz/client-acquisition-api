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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "client-acquisition-api",
  });
});

app.get("/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      healthy: true,
      database: true,
      time: result.rows[0].now,
    });
  } catch (error) {
    console.error("Health error:", error);
    res.status(500).json({
      healthy: false,
      database: false,
      error: error.message || "Unknown error",
      detail: String(error),
    });
  }
});

app.get("/companies", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        company_name,
        plan,
        credits_total,
        credits_used,
        status,
        primary_color,
        secondary_color,
        logo_url,
        prompt_profile,
        created_at
      FROM companies
      ORDER BY id ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Companies error:", error);
    res.status(500).json({
      error: error.message || "Unknown error",
      detail: String(error),
    });
  }
});

app.get("/leads", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        company_id,
        scan_id,
        lead_name,
        website,
        instagram_status,
        ads_status,
        website_score,
        opportunity_score,
        priority,
        sales_hook,
        channel,
        status,
        notes,
        created_at
      FROM leads
      ORDER BY id DESC
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Leads error:", error);
    res.status(500).json({
      error: error.message || "Unknown error",
      detail: String(error),
    });
  }
});

app.get("/leads/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const leadResult = await pool.query(
      `
      SELECT
        id,
        company_id,
        scan_id,
        lead_name,
        website,
        instagram_status,
        ads_status,
        website_score,
        opportunity_score,
        priority,
        sales_hook,
        channel,
        status,
        notes,
        created_at
      FROM leads
      WHERE id = $1
      `,
      [id]
    );

    if (leadResult.rows.length === 0) {
      return res.status(404).json({
        error: "Lead not found",
      });
    }

    const auditResult = await pool.query(
      `
      SELECT
        id,
        lead_id,
        audit_summary,
        audit_html,
        pdf_url,
        created_at
      FROM audits
      WHERE lead_id = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [id]
    );

    const outreachResult = await pool.query(
      `
      SELECT
        id,
        lead_id,
        action_type,
        status,
        notes,
        created_at
      FROM outreach_actions
      WHERE lead_id = $1
      ORDER BY created_at DESC
      `,
      [id]
    );

    res.json({
      lead: leadResult.rows[0],
      audit: auditResult.rows[0] || null,
      outreach_actions: outreachResult.rows,
    });
  } catch (error) {
    console.error("Lead detail error:", error);
    res.status(500).json({
      error: error.message || "Unknown error",
      detail: String(error),
    });
  }
});

app.get("/scans", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        company_id,
        industry,
        region,
        lead_limit,
        status,
        started_at,
        finished_at,
        created_at
      FROM scans
      ORDER BY id DESC
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Scans error:", error);
    res.status(500).json({
      error: error.message || "Unknown error",
      detail: String(error),
    });
  }
});

app.post("/scan/start", async (req, res) => {
  try {
    const {
      company_id,
      industry,
      region,
      lead_limit
    } = req.body;

    if (!company_id || !industry || !region || !lead_limit) {
      return res.status(400).json({
        error: "company_id, industry, region und lead_limit sind erforderlich",
      });
    }

    const insertResult = await pool.query(
      `
      INSERT INTO scans (
        company_id,
        industry,
        region,
        lead_limit,
        status,
        created_at
      )
      VALUES ($1, $2, $3, $4, 'queued', NOW())
      RETURNING *
      `,
      [company_id, industry, region, lead_limit]
    );

    const newScan = insertResult.rows[0];

    let webhookResult = {
      sent: false,
      status: null,
      error: null,
    };

    if (N8N_SCAN_WEBHOOK_URL) {
      try {
        const webhookResponse = await fetch(N8N_SCAN_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            scan_id: newScan.id,
            company_id: newScan.company_id,
            industry: newScan.industry,
            region: newScan.region,
            lead_limit: newScan.lead_limit,
            status: newScan.status,
            created_at: newScan.created_at,
          }),
        });

        webhookResult = {
          sent: true,
          status: webhookResponse.status,
          error: null,
        };
      } catch (webhookError) {
        console.error("Webhook error:", webhookError);
        webhookResult = {
          sent: false,
          status: null,
          error: webhookError.message || "Webhook request failed",
        };
      }
    }

    res.status(201).json({
      message: "Scan erfolgreich angelegt",
      scan: newScan,
      webhook: webhookResult,
    });
  } catch (error) {
    console.error("Scan start error:", error);
    res.status(500).json({
      error: error.message || "Unknown error",
      detail: String(error),
    });
  }
});

app.listen(PORT, () => {
  console.log(`API läuft auf Port ${PORT}`);
});