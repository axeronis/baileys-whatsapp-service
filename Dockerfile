FROM node:18-alpine

WORKDIR /app

# Install git (required by Baileys dependencies)
RUN apk add --no-cache git

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
