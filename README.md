
# AnythingLLM – Headless Code Indexer (WIP)
*A focused fork of the original [Mintplex‑Labs/anything‑llm](https://github.com/Mintplex-Labs/anything-llm) aimed at powering Retrieval‑Augmented Generation for large codebases.*

---

## Project focus

This fork is being **stripped down to a headless service** whose sole job is to:

1. Parse source files into language‑specific **Abstract Syntax Tree (AST) chunks**  
2. Attach metadata capturing relationships between those chunks  
3. Generate embeddings that place code and natural‑language queries in the same vector space  

Everything unrelated to that goal will eventually be removed, but some of the upstream UI & agent features still live in the codebase while work continues.

### Current status

| Component | Completion |
|-----------|------------|
| AST chunking (PHP, JS & CSS) | **✅ 100 %** |
| Relationship metadata graph | **~ 70 %** |
| Code‑tuned, vector‑ready embeddings | **~ 70 %** |

*(percentages reflect implementation progress as of May 2025)*

---

## Quick start

Build the container directly from the **Dockerfile** in the repository root:

```bash
# clone your fork
git clone <this-repo>
cd anything-ast

# build image
docker build -t anythingllm-ast .


# run (example)
mkfir ~/anythingllm
docker run -d \
  --user anythingllm \
  --cap-add CAP_SYS_ADMIN \
  --network bridge \
  --workdir /app \
  -p 3002:3001 \
  --restart no \
  --runtime runc \
  \
  # env vars
  --env CHROME_PATH=/app/chrome-linux/chrome \
  --env PUPPETEER_EXECUTABLE_PATH=/app/chrome-linux/chrome \
  --env PUPPETEER_DOWNLOAD_BASE_URL=https://storage.googleapis.com/chrome-for-testing-public \
  --env PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  --env NODE_ENV=production \
  --env ANYTHING_LLM_RUNTIME=docker \
  --env STORAGE_DIR=/storage \
  --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  \
  # volumes
  --volume ~/anythingllm:/storage \
  --volume /Users/sherif/anythingllm/my-codebase:/app/codebase \
  \
  # labels
  --label org.opencontainers.image.ref.name=ubuntu \
  --label org.opencontainers.image.version=22.04 \
  \
  anythingllm:anythingllm-ast
```

The container boots the server and collector; mount a volume to `~/anythingllm` to persist the vector store.

---

## Want the full, feature‑rich version?

If you need the desktop chat UI, agent builder, or multimodal support, grab the original project instead:

<https://github.com/Mintplex-Labs/anything-llm>

---

## License

This fork retains the MIT licence.

© 2025 The maintainers · Original © Mintplex Labs
