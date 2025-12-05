# Baileys WhatsApp Service

Free WhatsApp API using Baileys library.

## Features

- ✅ QR Code generation
- ✅ Send/receive messages  
- ✅ Session management
- ✅ Multi-instance support

## Environment Variables

```
PORT=8080
API_KEY=your-secret-api-key
```

## API Endpoints

### Create Instance
```bash
POST /instance/create
Headers: apikey: your-api-key
Body: { "instanceName": "tenant_xxx" }
```

### Get Status
```bash
GET /instance/fetchInstances?instanceName=tenant_xxx
Headers: apikey: your-api-key
```

### Send Message
```bash
POST /message/sendText/tenant_xxx
Headers: apikey: your-api-key
Body: { "number": "1234567890", "text": "Hello!" }
```

### Delete Instance
```bash
DELETE /instance/delete/tenant_xxx
Headers: apikey: your-api-key
```

## Deploy to Railway

1. Push to GitHub
2. Create new project in Railway
3. Add environment variables
4. Deploy!

## Cost

**FREE** on Railway Free Tier ($5/month credits)
