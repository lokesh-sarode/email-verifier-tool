import dotenv from 'dotenv';
dotenv.config();

import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { stringify } from 'csv-stringify/sync';
import { pool, initDb } from './db.js';
import { extractEmails, splitUniqueAndDuplicates } from './files.js';
import { processJob } from './processor.js';
import { checkEmailWithReacher } from './reacher.js';

const app = express();
const port = Number(process.env.PORT || 5000);
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024 }
});

app.use(cors({ origin: frontendUrl }));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/jobs/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const emails = await extractEmails(req.file);
    const { unique, duplicates } = splitUniqueAndDuplicates(emails);
    const jobResult = await pool.query(
      `INSERT INTO validation_jobs (file_name, status, total_records, duplicate_count)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.file.originalname, 'waiting', emails.length, duplicates.length]
    );
    const job = jobResult.rows[0];
    processJob(job.id, unique, duplicates);
    res.status(201).json({ job });
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs', async (_req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM validation_jobs ORDER BY created_at DESC');
    res.json({ jobs: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM validation_jobs WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Job not found' });
    res.json({ job: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs/:id/download', async (req, res, next) => {
  try {
    const job = await pool.query('SELECT * FROM validation_jobs WHERE id = $1', [req.params.id]);
    if (!job.rows[0]) return res.status(404).json({ error: 'Job not found' });
    if (job.rows[0].status !== 'complete') return res.status(409).json({ error: 'Job is not complete yet' });

    const results = await pool.query(
      `SELECT original_email, normalized_email, status, is_reachable, syntax_valid, domain,
              mx_accepts_mail, is_disposable, is_role_account, is_catch_all, reason, checked_at
       FROM validation_results
       WHERE job_id = $1
       ORDER BY id ASC`,
      [req.params.id]
    );
    const csv = stringify(results.rows, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="cleaned-${job.rows[0].file_name.replace(/[^a-z0-9_.-]/gi, '_')}"`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

app.post('/api/verify/single', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim();
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const result = await checkEmailWithReacher(email);
    res.json({ result });
  } catch (error) {
    next(error);
  }
});

app.get('/api/settings', (_req, res) => {
  res.json({
    reacherApiUrl: process.env.REACHER_API_URL || '',
    hasApiKey: Boolean(process.env.REACHER_API_KEY && process.env.REACHER_API_KEY !== 'ADD_API_KEY_LATER'),
    validationDelayMs: Number(process.env.VALIDATION_DELAY_MS || 500)
  });
});

app.get('/api/settings/test', async (_req, res) => {
  const baseUrl = (process.env.REACHER_API_URL || '').replace(/\/$/, '');
  if (!baseUrl) return res.status(400).json({ error: 'REACHER_API_URL is not configured' });
  try {
    const response = await fetch(`${baseUrl}/`, { method: 'GET' });
    res.status(response.ok ? 200 : 502).json({
      message: response.ok ? 'Reacher API is reachable' : `Reacher API responded with ${response.status}`
    });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Reacher API is not reachable' });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message });
  }
  console.error(error);
  res.status(500).json({ error: error.message || 'Internal server error' });
});

initDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`Email verifier API running on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to start server', error);
    process.exit(1);
  });
