# Relatório Técnico de Análise de Tráfego: Instagram Web CAA Login

**Arquivo Analisado**: `www.instagram.com.har`  
**Origem / Diretório**: `C:\Users\AXION\Desktop\TFs\ig-tf-main`  
**Data da Análise**: 07/09/2026  
**Contexto**: Mapeamento técnico de autenticação web, mutações GraphQL e telemetria para validação de credenciais em tempo real.

---

## 1. Visão Geral do Tráfego

O arquivo HAR registra uma sequência de **9 requisições HTTP/2 via TLS** direcionadas aos servidores da Meta / Instagram:

| # | Método | Status | Endpoint | Função / Propósito |
|---|---|---|---|---|
| 0 | POST | 200 | `https://www.instagram.com/ajax/bz` | Telemetria Comet / Polaris (QPL & Logging) |
| 1 | POST | 200 | `https://www.instagram.com/ajax/bz` | Telemetria Comet / Polaris pré-mutação |
| **2** | **POST** | **200** | **`https://www.instagram.com/api/graphql`** | **Mutação de Autenticação (`useCDSWebLoginMutation`)** |
| 3 | POST | 200 | `https://www.instagram.com/ajax/bz` | Telemetria pós-mutação (QPL `516759801`) |
| 4 | POST | 200 | `https://www.instagram.com/ajax/bz` | Telemetria de renderização de erro |
| 5 | POST | 200 | `https://www.instagram.com/ajax/bz` | Telemetria de interface (CDS / Polaris) |
| 6 | POST | 200 | `https://www.instagram.com/ajax/bz` | Telemetria de tempo de resposta |
| 7 | POST | 200 | `https://www.instagram.com/ajax/bz` | Telemetria de tracking |
| 8 | POST | 200 | `https://www.instagram.com/ajax/bz` | Telemetria de ciclo de vida da rota |

---

## 2. Anatomia da Requisição Central de Login

### 2.1 Especificações do Endpoint

- **URL**: `https://www.instagram.com/api/graphql`
- **Método**: `POST`
- **Content-Type**: `application/x-www-form-urlencoded`
- **Tamanho do Payload**: 3.475 bytes

### 2.2 Headers Críticos

```http
POST /api/graphql HTTP/2
Host: www.instagram.com
Content-Type: application/x-www-form-urlencoded
Origin: https://www.instagram.com
Referer: https://www.instagram.com/?flo=true
User-Agent: Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36
X-ASBD-ID: 359341
X-CSRFToken: cQCbNlo7wLf1YYRLN8LTBTsdZbm5Nx1T
X-FB-Friendly-Name: useCDSWebLoginMutation
X-FB-LSD: AdQddCxcz0GPZVLBrtpMOS6rbkc
X-IG-App-ID: 936619743392459
X-IG-Max-Touch-Points: 0
```

### 2.3 Parâmetros Form-UrlEncoded

- `doc_id`: `27972648395719857` (Identificador permanente da mutação GraphQL no servidor Meta)
- `fb_api_req_friendly_name`: `useCDSWebLoginMutation`
- `server_timestamps`: `true`
- `__user`: `0` (Usuário anônimo / não autenticado)
- `__a`: `1`
- `__req`: `o`
- `lsd`: Token anti-automação / CSRF Meta (`AdQddCxcz0GPZVLBrtpMOS6rbkc`)
- `jazoest`: Hash de validação do formulário (`22424`)
- `variables`: Objeto JSON serializado contendo os dados de login.

---

## 3. Estrutura do Payload (`variables.input`)

```json
{
  "input": {
    "actor_id": "0",
    "client_mutation_id": "1",
    "access_flow_version": "pre_mt_behavior",
    "account_recovery_entry_point": null,
    "app": "instagram",
    "auth_domain_data_key": null,
    "caa_login_request_extra_info": {
      "ab_test_data": "",
      "shared_prefs_data": "",
      "cuid": "",
      "guid": "fc358c9b2ee25a05f",
      "jazoest": "",
      "lgndim": "",
      "lgnjs": "1788764305",
      "lgnrnd": "",
      "locale": "",
      "login_source": "caa_login",
      "lsd": "",
      "next": "",
      "prefill_contact_point": "",
      "prefill_source": "",
      "prefill_type": "",
      "skstamp": "",
      "timezone": ""
    },
    "credential_type": "device_based_login_password",
    "dyi_job_id": "",
    "enc_password": {
      "sensitive_string_value": "#PWD_BROWSER:10:<timestamp>:<cipher>"
    },
    "event_request_id": "97a20550-b5b8-4c18-98b5-a176bcf31e7b",
    "identifier": "<username_ou_token_identifier>",
    "ig_web_device_id": "E810DF37-59DB-4106-83CD-464997B08B90",
    "initial_request_id": "1",
    "lids": null,
    "login_source": "DEVICE_BASED_LOGIN",
    "next": null,
    "password": null,
    "persistent": true,
    "query_params": "{\"flo\":\"true\"}",
    "trusted_device_records": "{}",
    "use_uid_to_login": true,
    "waterfall_id": "bfeef4aa-dbe1-497c-afbd-05bc1d5ece7f"
  },
  "scale": 1
}
```

### Detalhamento dos Campos Críticos:
1. **`enc_password`**:
   - Formato: `#PWD_BROWSER:10:<timestamp>:<cipher>`
   - Criptografado no frontend pelo bundle JS do Instagram via criptografia de chave pública NaCl / WebCrypto.
2. **`identifier`**:
   - Nome de usuário, telefone ou token de identificador prévio de sessão.
3. **`waterfall_id` e `ig_web_device_id`**:
   - UUIDs únicos gerados por sessão do navegador para controle de fluxo e anti-fraude.

---

## 4. Anatomia da Resposta GraphQL

A resposta HTTP 200 retorna um payload JSON estruturado com a árvore `data.caa_login_web`:

```json
{
  "data": {
    "caa_login_web": {
      "error_code": 1348009,
      "error_message": {
        "text": "A senha inserida está incorreta. Esqueceu a senha?",
        "inline_style_ranges": [],
        "image_ranges": [],
        "ranges": [
          {
            "entity_is_weak_reference": false,
            "length": 17,
            "offset": 33,
            "entity": {
              "__typename": "ExternalUrl",
              "url": "http://instagram.com/accounts/password/reset/",
              "__isNode": "ExternalUrl",
              "id": "NjQyMTgzOTU5MjA4MTA3Omh0dHBcYS8vaW5zdGFncmFtLmNvbS9hY2NvdW50cy9wYXNzd29yZC9yZXNldC86Ojo6Ojo="
            }
          }
        ],
        "color_ranges": []
      },
      "error_style": "GENERIC_BANNER",
      "redirect_uri": null,
      "two_factor_result": null,
      "reg_nta_context": null,
      "is_3pl": null,
      "is_xapp_login": false,
      "recaptcha_needed": false,
      "is_ig_login_recaptcha": false,
      "should_show_profile_selector": false,
      "should_show_save_password_dialog": false,
      "captcha_persist_data": null,
      "crypted_uid": null,
      "ig_nonce_refresh": null,
      "ig_trusted_device_nonce_refresh": null,
      "stop_deletion_payload": {
        "stop_deletion_nonce": null,
        "stop_deletion_date": null,
        "is_feta": false
      },
      "ig_authenticated": false,
      "ig_login_upsell_ar": null,
      "should_show_google_oauth_after_failure": false,
      "google_oauth_uri": null
    }
  },
  "extensions": {
    "server_metadata": {
      "request_start_time_ms": 1788764304739,
      "time_at_flush_ms": 1788764307561
    },
    "is_final": true
  }
}
```

---

## 5. Mapeamento de Estados para Validação

Com base no schema da Meta exposto em `caa_login_web`, os estados são classificados com precisão:

| Condição no JSON de Resposta | Status da Credencial | Ação do Sistema |
|---|---|---|
| `error_code === 1348009` | **`invalido`** (Senha incorreta) | Notificar `/api/resultado-bot` (`valido: false`), resetar tela de login e permitir redigitação. |
| `two_factor_result !== null` | **`valido`** (2FA Requerido) | Notificar `/api/resultado-bot` (`valido: true`), solicitar 2FA no painel e avançar usuário para `/codigo/`. |
| `recaptcha_needed === true` ou `is_ig_login_recaptcha === true` | **`bloqueio_captcha`** | Sinalizar necessidade de resolução de desafio ou alternância de IP/proxy. |
| `ig_authenticated === true` | **`valido`** (Login direto) | Sessão autenticada. |

---

## 6. Arquitetura de Integração com o Ecossistema IG Monitor

```text
[Cliente: public/index.html]
       │
       ▼ (1) POST /salvar
[Servidor: server.js] ──(SSE)──► [Painel: public/painel.html] (🟡 Testando...)
       │
       ▼ (2) Disparo de Teste
 [Worker / Bot Validador] ──(Mutação GraphQL / Playwright)──► [Instagram CAA Login]
                                                                     │
                                                 ┌───────────────────┴───────────────────┐
                                                 ▼                                       ▼
                                       error_code: 1348009                     two_factor_result != null
                                        (Senha Incorreta)                           (2FA Disparado)
                                                 │                                       │
                                                 ▼                                       ▼
                                          valido = false                           valido = true
                                                 │                                       │
                                                 └───────────────────┬───────────────────┘
                                                                     ▼
                                                     POST /api/resultado-bot
                                                                     │
                                             ┌───────────────────────┴───────────────────────┐
                                             ▼                                               ▼
                                  [Painel do Operador]                               [Tela da Vítima]
                                🔴 Senha Incorreta / 🟢 Válida                      Exibe erro ou avança 2FA
```
