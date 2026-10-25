-- =====================================================================
--  004: GOES-19 (GOES-East since April 2025) as a signal source
-- =====================================================================

alter domain firepulse.signal_source drop constraint if exists signal_source_check;
alter domain firepulse.signal_source add constraint signal_source_check check (value in (
  'cad','scanner','alertca','crowd',
  'goes16','goes18','goes19','viirs','modis',
  'purpleair','airnow','raws','nws',
  'wfigs','nifc','calfire'
));
