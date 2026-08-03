# Wine API

API de vinhos compatível com o contrato da referência `wine-api-two.vercel.app`, com Swagger UI para integração mobile.

## Rodando localmente

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run dev
```

Endpoints principais:

- `GET /`
- `GET /wines`
- `GET /wines/autocomplete`
- `GET /wines/lwin/:lwin`
- `GET /wines/:id`
- `POST /wine-scanner/scan`
- `GET /api/docs`
- `GET /api/docs-json`

## Importando mais vinhos da API de referência

O seed local inclui uma amostra pequena para desenvolvimento. Para importar páginas da API pública de referência para o Neon:

```bash
npm run db:import -- --pages=10 --limit=100
```

Use `--truncate` se quiser limpar a tabela antes de importar:

```bash
npm run db:import -- --truncate --pages=25 --limit=100
```

## Scanner

O endpoint `POST /wine-scanner/scan` recebe `multipart/form-data` no campo `image`. Quando `OPENROUTER_API_KEY` está configurado, a API chama o modelo definido em `OPENROUTER_MODEL` para extrair os dados do rótulo.

O modelo padrão sugerido é `google/gemma-4-26b-a4b-it:free`, que aceita imagem via OpenRouter. Para usar Gemini, configure `OPENROUTER_MODEL=google/gemini-2.5-flash` e garanta que a conta OpenRouter tenha créditos.
