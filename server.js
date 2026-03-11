const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

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
    res.status(500).json({
      healthy: false,
      database: false,
      error: error.message,
    });
  }
});

app.get("/companies", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, company_name, plan, credits_total, credits_used, status, created_at
      FROM companies
      ORDER BY id ASC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/leads", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, company_id, lead_name, website, instagram_status, ads_status,
             website_score, opportunity_score, priority, sales_hook, channel, status, created_at
      FROM leads
      ORDER BY id DESC
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`API läuft auf Port ${PORT}`);
});