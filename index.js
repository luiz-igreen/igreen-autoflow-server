| ❌ Timeouts curtos | ✅ Aumentados para 60s (navegação), 45s (Gemini) |
| ❌ Sem retry logic | ✅ Retry com backoff exponencial (2s, 4s, 8s) |
| ❌ Map() em memória | ✅ Firestore para persistência em serverless |
| ❌ Sem headers anti-bot | ✅ User-Agent realista + headers HTTP |
| ❌ Sem validação de credenciais | ✅ Verificação na inicialização |
| ❌ Sem tratamento de login falho | ✅ Detecção de erros na página |
| ❌ Sem espera por renderização | ✅ `waitForFunction` + delays progressivos |

**Próximos passos:**
1. Defina as variáveis de ambiente (GEMINI_API_KEY, IGREEN_USER, IGREEN_PASS, FIREBASE_CONFIG)
2. Teste o webhook com uma mensagem simples
3. Monitore os logs no Render para validar fluxo

Quer que eu crie um arquivo `.env.example` ou um guia de deployment?
