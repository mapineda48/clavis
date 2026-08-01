-- =============================================================================
-- 0002_views.sql — Support views for the administration panel.
-- =============================================================================

-- A single row with the global counts per status and per priority.
-- Meant for GET /api/admin/stats: `SELECT * FROM erp.v_todo_stats`.
CREATE OR REPLACE VIEW erp.v_todo_stats AS
SELECT
  count(*)::bigint                                                      AS total,
  count(*) FILTER (WHERE status = 'todo')::bigint                       AS status_todo,
  count(*) FILTER (WHERE status = 'in_progress')::bigint                AS status_in_progress,
  count(*) FILTER (WHERE status = 'done')::bigint                       AS status_done,
  count(*) FILTER (WHERE priority = 1)::bigint                          AS priority_1,
  count(*) FILTER (WHERE priority = 2)::bigint                          AS priority_2,
  count(*) FILTER (WHERE priority = 3)::bigint                          AS priority_3,
  count(*) FILTER (WHERE priority = 4)::bigint                          AS priority_4,
  count(*) FILTER (WHERE assignee_id IS NULL)::bigint                   AS unassigned,
  count(*) FILTER (
    WHERE due_date IS NOT NULL
      AND due_date < current_date
      AND status <> 'done'
  )::bigint                                                             AS overdue
FROM erp.todos;

COMMENT ON VIEW erp.v_todo_stats IS
  'Single row with the task counts per status and per priority, plus the unassigned and overdue ones.';
