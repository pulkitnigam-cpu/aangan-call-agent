-- Vaani's live call_postprocessing sends call_duration in seconds (its docs say
-- milliseconds), so early calls were stored as 0 s. Recompute them from Vaani's
-- own start/end stamps in the stored payload.
update calls
set duration_sec = greatest(0, round(extract(epoch from (
      (raw_payload->'data'->>'call_ended_at')::timestamptz - (raw_payload->'data'->>'picked_up_at')::timestamptz
    )))::int),
    started_at = (raw_payload->'data'->>'picked_up_at')::timestamptz
where coalesce(duration_sec, 0) = 0
  and raw_payload->'data'->>'picked_up_at' is not null
  and raw_payload->'data'->>'call_ended_at' is not null;
