import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { actionItemsRouter } from './actionItems.js';
import { authRouter } from './auth.js';
import { directoryRouter } from './directory.js';
import { emailsRouter } from './emails.js';
import { healthRouter } from './health.js';
import { insightsRouter } from './insights.js';
import { integrationsRouter } from './integrations.js';
import { meetingsRouter } from './meetings.js';
import { projectsRouter } from './projects.js';
import { tasksRouter } from './tasks.js';
import { teamsRouter } from './teams.js';
import { usersRouter } from './users.js';
import { webhooksRouter } from './webhooks.js';
import { activitiesRouter, externalRecordsRouter, recordLinksRouter, searchRouter } from './workRecords.js';

// Mounted at /api/v1. Admin-only routers sit behind requireAuth + requireRole('admin').
export const apiRouter = Router();

const adminOnly = [requireAuth, requireRole('admin')];

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/users', ...adminOnly, usersRouter);
apiRouter.use('/meetings', ...adminOnly, meetingsRouter);
apiRouter.use('/action-items', ...adminOnly, actionItemsRouter);
apiRouter.use('/emails', ...adminOnly, emailsRouter);
// Integrations (Phase 3A): connecting external applications is admin-only.
apiRouter.use('/integrations', ...adminOnly, integrationsRouter);
// Synced work and the unified feed (Phase 3A/4): any signed-in user; visibility follows projects
// and tasks; relationship changes: admins, or managers within projects they manage.
apiRouter.use('/external-records', requireAuth, externalRecordsRouter);
apiRouter.use('/activities', requireAuth, activitiesRouter);
apiRouter.use('/record-links', requireAuth, recordLinksRouter);
// Unified search (Phase 4) across projects, meetings, tasks and synced records.
apiRouter.use('/search', requireAuth, searchRouter);
// Insights (Phase 7): health, overdue, blockers, reviews, follow-through, workload, trends; scoped per person.
apiRouter.use('/insights', requireAuth, insightsRouter);
// Inbound provider webhooks: public, verified by signature (services/integrations/webhooks.js).
apiRouter.use('/webhooks', webhooksRouter);
// The signed-in user's own tasks (employee portal). Not admin-only, but always scoped to req.user.
apiRouter.use('/me/tasks', requireAuth, tasksRouter);
// Projects and teams (Phase 2): any signed-in user; per-resource permissions in the controllers.
apiRouter.use('/projects', requireAuth, projectsRouter);
apiRouter.use('/teams', requireAuth, teamsRouter);
apiRouter.use('/directory', requireAuth, requireRole('admin', 'manager'), directoryRouter);
