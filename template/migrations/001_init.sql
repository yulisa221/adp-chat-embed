-- ADP 对话接入：会话列表与消息记录（按访客 / 用户隔离）
CREATE TABLE IF NOT EXISTS adp_chat_conversations (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adp_chat_conversations_owner ON adp_chat_conversations (owner, updated_at DESC);

CREATE TABLE IF NOT EXISTS adp_chat_records (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adp_chat_records_conversation ON adp_chat_records (conversation_id, id);
