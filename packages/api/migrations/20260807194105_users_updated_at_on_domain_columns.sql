-- =============================================================================
-- Restrict trg_users_set_updated_at to the domain columns of clavis.users.
--
-- The trigger was declared as an unconditional BEFORE UPDATE ... FOR EACH ROW,
-- so it also fired for the presence mark the API writes on every authenticated
-- request (UPDATE clavis.users SET last_seen_at = now()). The result was that
-- updated_at measured traffic instead of edits: it moved every time the user
-- presented a token, and answered "when was this user last modified" with
-- "just now" for anyone who is simply logged in.
--
-- UPDATE OF <columns> fires only when the statement's SET list mentions one of
-- the listed columns. It is the SET list that counts, not whether the value
-- actually changed, so `SET status = COALESCE($1, status)` still fires even
-- when the argument is NULL -- which is exactly what PATCH /api/users/:id
-- does, and exactly what we want. A last_seen_at-only update no longer fires
-- it at all. Verified empirically against PostgreSQL 17.6.
--
-- last_seen_at deliberately stays out of the list: it is presence, not an
-- edit. created_at and updated_at are not in it either, for the same reason.
-- =============================================================================

DROP TRIGGER IF EXISTS trg_users_set_updated_at ON clavis.users;
CREATE TRIGGER trg_users_set_updated_at
  BEFORE UPDATE OF username, email, display_name, is_root, status
  ON clavis.users
  FOR EACH ROW
  EXECUTE FUNCTION clavis.set_updated_at();

COMMENT ON COLUMN clavis.users.updated_at IS
  'Last edit of the user record itself (username, email, display_name, is_root, status). Presence is last_seen_at, and it does not move this column.';
