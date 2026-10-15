-- Correct the seeded rolling recalculation task. Older installations labelled it as
-- a single-day metric job, so the scheduler only recalculated one date.
UPDATE bi_task
SET task_type = 'metric_backfill', updated_at = now()
WHERE code = 'task_metric_recalc' AND task_type = 'metric_calc';
