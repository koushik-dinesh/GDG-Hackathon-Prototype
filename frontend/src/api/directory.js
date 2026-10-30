import { api } from './client.js';

// Active people that admins and managers can add to projects and teams.
export const listPeople = () => api('/directory/users');
