# Nanoclaw — Claude Code Development Brief
> Prepared for: Claude Code with full filesystem + execution permissions
> Last updated: 2026-02-28

---

## What is Nanoclaw?

Nanoclaw is a privacy-first personal AI assistant that routes tasks between a **local LLM** (for personal/sensitive work) and the **Anthropic Claude SDK** (for complex coding/reasoning tasks). It is built as a modular Python system and integrates with WhatsApp for messaging.

---

## Current State — What's Already Done

### ✅ Task 1.1 — Local LLM Integration (COMPLETE)

The local LLM stack is fully operational. Do NOT rebuild this. Treat it as a stable dependency.

- **Repo:** `~/intel-gpu-inference` (also at https://github.com/tunmaker/intel-gpu-inference)
- **Runtime:** `llama.cpp` with SYCL backend (Intel Arc A770, 16GB VRAM)
- **API:** OpenAI-compatible server at `http://localhost:8080/v1`
- **Endpoints available:**
  - `POST /v1/chat/completions`
  - `POST /v1/completions`
  - `POST /v1/embeddings`
  - Tool/function calling is supported natively
- **Service:** Runs as systemd unit `llama-server` (auto-starts on boot)
- **Current model:** Whatever is loaded — check with `GET http://localhost:8080/v1/models`
- **Python client example:**
  ```python
  from openai import OpenAI
  local = OpenAI(base_url="http://localhost:8080/v1", api_key="not-needed")
  resp = local.chat.completions.create(
      model="default",
      messages=[{"role": "user", "content": "Hello"}]
  )
  ```
- **Important Intel Arc quirks:**
  - Use Q8_0 or Q4_0 quants (K-quants are ~3x slower on SYCL)
  - `UR_L0_ENABLE_RELAXED_ALLOCATION_LIMITS=1` must be set (already in env.sh)
  - `ZE_FLAT_DEVICE_HIERARCHY=FLAT` for stable single-GPU behavior

---

## What Needs to Be Built

Work through these phases in order. Each phase is a standalone deliverable.

---

### Phase 1 — Routing & Privacy (Start Here)

#### Task 1.2 — Task-Based Routing Logic

Build the core routing engine that decides which LLM handles each message.

**Deliverable:** `nanoclaw/router.py`

```
Rules (in priority order):
1. Contains sensitive patterns → local LLM only
2. Is a coding/debugging task → Claude SDK
3. Requires real-time/web info → local LLM + web search tool
4. Default → local LLM (privacy-first)
```

Requirements:
- Routing rules defined in `configs/routing.yaml` (not hardcoded)
- Each decision logged with reason: `{"message_id": "...", "routed_to": "local|claude", "reason": "..."}`
- Routing must be async (`asyncio`)
- Unit tests in `tests/test_router.py` covering all rule paths
- Include a simple CLI: `python -m nanoclaw.router --test "your message here"` that shows the routing decision

#### Task 1.3 — Privacy Filtering Middleware

Build a data sanitizer that strips sensitive info before anything goes to external APIs.

**Deliverable:** `nanoclaw/privacy.py`

Sensitive patterns to detect and redact (configurable in `configs/privacy.yaml`):
- Passwords, API keys, tokens
- Credit card numbers (Luhn-valid patterns)
- Personal names + addresses in combination
- SSH private keys
- Phone numbers, national ID formats

Requirements:
- `sanitize(text: str) -> tuple[str, list[str]]` — returns cleaned text + list of what was redacted
- Works as middleware: router calls sanitize before any external API call
- Audit log of every outbound request (sanitized copy only): `logs/outbound.jsonl`
- "Privacy mode" flag in config: when True, blocks ALL external API calls regardless of routing rules
- Tests with real-looking fake sensitive data

---

### Phase 2 — Knowledge & Learning

#### Task 2.1 — Persistent Knowledge Base

**Deliverable:** `nanoclaw/knowledge.py` + SQLite DB at `data/knowledge.db`

Schema:
```sql
CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    category TEXT,           -- 'task_example', 'feedback', 'prompt', 'skill'
    content TEXT,
    embedding BLOB,          -- optional: float32 vector for semantic search
    metadata JSON,
    created_at DATETIME,
    updated_at DATETIME
);
```

Requirements:
- CRUD: `add_entry()`, `get_entry()`, `update_entry()`, `delete_entry()`
- Keyword search: `search(query, category=None, limit=10)`
- Semantic search (optional but preferred): use local embeddings via `http://localhost:8080/v1/embeddings`
- Versioning: entries are never deleted, only superseded (soft delete with `superseded_by` field)
- CLI: `python -m nanoclaw.knowledge search "routing rules"`

#### Task 2.2 — Feedback & Annotation System

**Deliverable:** `nanoclaw/feedback.py`

Structured feedback templates:
```python
class FeedbackType(Enum):
    WORKED = "worked"
    FAILED = "failed"
    IMPROVED = "improved"
    PRIVACY_CONCERN = "privacy_concern"
    SKILL_USED = "skill_used"
```

Requirements:
- `annotate(conversation_id, feedback_type, notes, improved_version=None)`
- Feedback stored in knowledge base (category='feedback')
- Weekly summary generator: `generate_report(since_date)` → markdown
- "Lesson extraction": after annotating, prompt local LLM to extract a reusable insight and store it

#### Task 2.3 — Skill Registry

**Deliverable:** `nanoclaw/skills.py` + `data/skills.db`

Schema per skill:
```python
@dataclass
class Skill:
    id: str
    name: str
    description: str
    prerequisites: list[str]
    success_count: int
    failure_count: int
    confidence: float          # 0.0 - 1.0
    example_prompts: list[str]
    last_used: datetime
    last_improved: datetime
    status: str                # 'active', 'in_development', 'deprecated'
```

Requirements:
- Track success/failure on each use: `record_use(skill_id, success: bool)`
- Confidence auto-calculated: `success_count / (success_count + failure_count)`
- Skill report: `python -m nanoclaw.skills report` → table of skills + confidence levels
- Suggest skill combinations for a given task description

Seed with at least these 5 skills to start:
1. `code_review` — reviewing and improving code
2. `privacy_filtering` — detecting and redacting sensitive info
3. `task_routing` — deciding which LLM to use
4. `fact_checking` — verifying claims with web search
5. `summarization` — condensing long content

---

### Phase 3 — Autonomous Decision Making

#### Task 3.1 — Intelligent Tool Selection

**Deliverable:** `nanoclaw/tool_selector.py`

Tool registry (extensible via `configs/tools.yaml`):
```yaml
tools:
  web_search:
    triggers: ["current", "latest", "today", "news", "price", "who is"]
    privacy_cost: low
    time_cost: medium
  code_execution:
    triggers: ["run", "execute", "compute", "calculate", "validate"]
    privacy_cost: local_only
    time_cost: high
  file_ops:
    triggers: ["save", "load", "read", "write", "list files"]
    privacy_cost: local_only
    time_cost: low
```

Requirements:
- `select_tools(message: str) -> list[str]` — returns ordered list of tools to use
- Tool chaining: if web_search + code_execution both triggered, execute in sequence
- Reasoning transparency: each selection logged with `{"tool": "...", "trigger": "...", "reason": "..."}`
- "Tool cost model": privacy_cost, time_cost, compute_cost per tool

#### Task 3.2 — Resource Optimization

**Deliverable:** `nanoclaw/cache.py` + `nanoclaw/quota.py`

Cache:
- Response cache: hash(model + messages) → cached response, with TTL
- Web search cache: hash(query) → results, TTL 1 hour for factual, 5 min for current events
- Storage: `data/cache.db` (SQLite)

Quota:
- Track Claude API calls: count + estimated tokens per day/month
- Alert thresholds configurable in `configs/quota.yaml`
- Auto-fallback: if Claude quota >80% used, route remaining to local LLM
- `python -m nanoclaw.quota status` → usage report

#### Task 3.3 — Self-Reflection System

**Deliverable:** `nanoclaw/reflection.py`

Requirements:
- Scheduled weekly reflection: prompts local LLM to analyze the past week's conversations
- Reflection prompts (stored in knowledge base, evolvable):
  - "What were the 3 most successful interactions this week?"
  - "What task types did you struggle with?"
  - "What privacy concerns came up and how were they handled?"
  - "What new skill would make you more capable?"
- Saves reflection output to knowledge base (category='reflection')
- Diff tracking: compare this week's reflection to last week's — what changed?

---

### Phase 4 — Personality & Context

#### Task 4.1 — Personality Profile

**Deliverable:** `configs/personality.yaml` + enforcement in system prompts

Default profile:
```yaml
tone: direct
verbosity: concise
explanation_style: examples_first
traits:
  - pragmatic
  - privacy_conscious
  - curious
  - honest
channel_overrides:
  whatsapp:
    verbosity: very_concise
    max_response_length: 500
```

Requirements:
- System prompt builder: `build_system_prompt(channel, context) -> str`
- Personality injected into every LLM call
- Effectiveness tracking: user can rate response style, stored in feedback system

#### Task 4.2 — Long-Term Context

**Deliverable:** `nanoclaw/context.py` + `data/user_profile.json`

User profile schema:
```json
{
  "goals": ["run local LLM stack", "build Nanoclaw"],
  "ongoing_projects": {"nanoclaw": "...", "intel-gpu-inference": "..."},
  "preferences": {"privacy": "strict", "response_style": "direct"},
  "work_patterns": {"active_hours": "09:00-22:00"},
  "known_context": {}
}
```

Requirements:
- Auto-update profile from conversations (extract facts with local LLM)
- Context injection: relevant profile info prepended to each request
- `python -m nanoclaw.context show` → current profile
- Trust indicators: `privacy_incidents_avoided`, `tasks_completed_correctly`

---

### Phase 5 — Integration & Testing

#### Task 5.1 — End-to-End Integration Tests

**Deliverable:** `tests/test_e2e.py`

Test scenarios required:
1. Personal message → routes to local LLM, no external API call
2. Coding question → routes to Claude SDK
3. Sensitive data → sanitized before any external call
4. Cache hit → second identical request returns cached response
5. Quota exceeded → auto-fallback to local LLM
6. Skill tracking → successful task increments skill confidence
7. Feedback → annotation stored and lesson extracted

#### Task 5.2 — Monitoring Dashboard

**Deliverable:** `nanoclaw/dashboard.py` (simple terminal dashboard, no web UI needed)

Use `rich` library for display. Show:
- System health: local LLM status, Claude API status
- Today's stats: requests, routing split (local vs Claude), cache hit rate
- Top skills used this week
- Quota status
- Last 5 privacy events
- Recent reflection summary

Run with: `python -m nanoclaw.dashboard`

---

### Phase 6 — Continuous Improvement

#### Task 6.1 — Skill Expansion Pipeline

**Deliverable:** `nanoclaw/skill_pipeline.py`

Three-stage pipeline for developing new skills:
1. **Explore:** gather examples of the task, store in knowledge base
2. **Develop:** practice with local LLM, annotate results
3. **Integrate:** promote to active skill registry when confidence >0.7

#### Task 6.2 — Prompt Evolution

**Deliverable:** `nanoclaw/prompt_manager.py`

- Version-controlled prompt library in `data/prompts.db`
- A/B testing: randomly serve prompt_v1 vs prompt_v2, track which performs better
- Auto-retire: prompts with <50% success rate after 20 uses get flagged
- `python -m nanoclaw.prompt_manager report` → effectiveness table

#### Task 6.3 — Privacy Hardening

**Deliverable:** `nanoclaw/audit.py`

- Weekly automated privacy audit: scan `logs/outbound.jsonl` for any unexpected patterns
- Privacy rule expansion: after each incident/near-miss, update `configs/privacy.yaml`
- Incident response workflow: `record_incident()`, `analyze_incident()`, `update_rules()`

---

## Project Structure (Target)

```
nanoclaw/
├── nanoclaw/
│   ├── __init__.py
│   ├── router.py              # Phase 1.2
│   ├── privacy.py             # Phase 1.3
│   ├── knowledge.py           # Phase 2.1
│   ├── feedback.py            # Phase 2.2
│   ├── skills.py              # Phase 2.3
│   ├── tool_selector.py       # Phase 3.1
│   ├── cache.py               # Phase 3.2
│   ├── quota.py               # Phase 3.2
│   ├── reflection.py          # Phase 3.3
│   ├── context.py             # Phase 4.2
│   ├── dashboard.py           # Phase 5.2
│   ├── prompt_manager.py      # Phase 6.2
│   ├── audit.py               # Phase 6.3
│   └── llm_clients.py         # Thin wrappers: local_llm() + claude()
├── configs/
│   ├── routing.yaml
│   ├── privacy.yaml
│   ├── tools.yaml
│   ├── quota.yaml
│   └── personality.yaml
├── data/                      # SQLite DBs, user profile (gitignored)
├── logs/                      # Audit logs (gitignored)
├── tests/
│   ├── test_router.py
│   ├── test_privacy.py
│   ├── test_e2e.py
│   └── fixtures/
├── scripts/
│   └── weekly_reflection.sh   # Cron job for scheduled reflection
├── requirements.txt
├── pyproject.toml
└── README.md
```

---

## Core Dependencies

```
openai>=1.0          # Client for both local llama.cpp API and Claude
anthropic>=0.30      # Direct Claude SDK (for richer tool use)
sqlalchemy>=2.0      # DB ORM for knowledge/skill/cache DBs
pyyaml               # Config files
httpx                # Async HTTP
rich                 # Terminal dashboard
pytest               # Testing
pytest-asyncio       # Async test support
numpy                # Embeddings math
```

---

## Key Design Constraints

1. **Privacy-first:** When in doubt, route to local LLM. Never send sensitive data externally.
2. **Async throughout:** All LLM calls must be async-compatible for WhatsApp integration.
3. **Config over code:** Routing rules, privacy patterns, tool triggers — all in YAML, not hardcoded.
4. **Fail safe:** If local LLM is down, surface a clear error rather than silently falling back to Claude.
5. **Local LLM endpoint is read-only infrastructure** — don't modify `~/intel-gpu-inference/`.
6. **Logging is mandatory** — every routing decision, every outbound call, every privacy event.
7. **Q8_0 models preferred** on the Arc A770 for best speed/quality tradeoff.

---

## Testing the Local LLM Before Starting

```bash
# Verify local API is up
curl http://localhost:8080/v1/models

# Quick sanity check
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Say hello in one word"}], "max_tokens": 10}'
```

---

## What Success Looks Like

After all phases:
- `python -m nanoclaw.router --test "what's my wife's name"` → `local_llm (sensitive: personal context)`
- `python -m nanoclaw.router --test "write a binary search in Python"` → `claude_sdk (coding task)`
- `python -m nanoclaw.dashboard` → live terminal dashboard showing system health
- `python -m nanoclaw.skills report` → table of 5+ skills with confidence scores
- All tests in `tests/` pass
- Zero sensitive data in `logs/outbound.jsonl`
