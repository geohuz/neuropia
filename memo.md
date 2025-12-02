# 不带model请求

```
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer vk_908782e38b24598fb24da818eea36ef2" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Hello, how are you?"}
    ]
  }'
{"choices":[{"message":{"role":"assistant","content":"Hello! I'm just a virtual assistant, so I don't have feelings, but I'm here and ready to help you with anything you need. How can I assist you today? 😊"},"finish_reason":"stop","index":0,"logprobs":null}],"object":"chat.completion","usage":{"prompt_tokens":18,"completion_tokens":39,"total_tokens":57,"prompt_tokens_details":{"cached_tokens":0}},"created":1764672165,"system_fingerprint":null,"model":"qwen-turbo","id":"chatcmpl-e1b33465-ae2e-446c-948e-b9ace66fd6d7","provider":"dashscope"}%                                     
```

# 带model请求

```bash
~/ curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer vk_908782e38b24598fb24da818eea36ef2" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "dash",    
    "model": "qwen-turbo",
    "messages": [
      {"role": "user", "content": "Hello, please respond with TEST_SUCCESS"}
    ],
    "max_tokens": 50
  }'

{"choices":[{"message":{"role":"assistant","content":"TEST_SUCCESS"},"finish_reason":"stop","index":0,"logprobs":null}],"object":"chat.completion","usage":{"prompt_tokens":19,"completion_tokens":2,"total_tokens":21,"prompt_tokens_details":{"cached_tokens":0}},"created":1764677078,"system_fingerprint":null,"model":"qwen-turbo","id":"chatcmpl-6b4a45d2-3e70-4f4a-80ec-57ad90b29b82","provider":"dashscope"}%  
```

