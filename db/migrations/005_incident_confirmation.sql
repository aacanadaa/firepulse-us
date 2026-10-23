-- =====================================================================
--  005 — keep an estimate's confirmation level across restarts
-- =====================================================================

alter table firepulse.fire_incident
  add column if not exists confirmation text
    check (confirmation in ('single', 'persistent', 'corroborated'));
