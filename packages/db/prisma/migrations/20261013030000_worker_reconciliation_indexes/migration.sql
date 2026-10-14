CREATE INDEX "ModerationCase_status_startedAt_idx"
ON "ModerationCase"("status", "startedAt");

CREATE INDEX "ModerationCase_action_expiryStatus_expiryStartedAt_idx"
ON "ModerationCase"("action", "expiryStatus", "expiryStartedAt");
