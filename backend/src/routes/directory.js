import { Router } from 'express';
import { pool } from '../db/pool.js';

// Mounted at /directory behind requireAuth + requireRole('admin', 'manager'). The people a
// manager can pick as project/team members: active users only, without admin-only details.
export const directoryRouter = Router();

directoryRouter.get('/users', async (req, res) => {
  const [rows] = await pool.query('SELECT id, full_name, email, role FROM users WHERE is_active = TRUE ORDER BY full_name');
  res.json({ users: rows.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email, role: r.role })) });
});
