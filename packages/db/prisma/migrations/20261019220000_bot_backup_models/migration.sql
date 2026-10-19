CREATE TABLE "bot_backup_models" (
    "botId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "bot_backup_models_pkey" PRIMARY KEY ("botId", "position"),
    CONSTRAINT "bot_backup_models_position_check" CHECK ("position" >= 0)
);

CREATE UNIQUE INDEX "bot_backup_models_botId_provider_modelId_key"
    ON "bot_backup_models"("botId", "provider", "modelId");

ALTER TABLE "bot_backup_models" ADD CONSTRAINT "bot_backup_models_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
