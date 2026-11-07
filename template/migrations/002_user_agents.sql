-- ADP 对话接入（方式二）：每个访客 / 用户一份 ADP 用户态 Agent（CopyAgentFromApp Kind=1 生成），
-- 用户在对话界面里切换模型、安装技能、启用工具 / 连接器，只改自己这份 Agent
CREATE TABLE IF NOT EXISTS adp_chat_user_agents (
  owner TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
