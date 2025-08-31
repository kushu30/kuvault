import express from "express"
import { MongoClient } from "mongodb"
import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys"
import qrcode from "qrcode-terminal"
import dotenv from "dotenv"
import pino from "pino"


dotenv.config()

const app = express()
const client = new MongoClient(process.env.MONGO_URI)
await client.connect()
const db = client.db("locker")
const store = db.collection("messages")
await store.createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 })

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info")

  const sock = makeWASocket({
  auth: state,
  logger: pino({ level: "error" }), // only error logs
  browser: ["Ubuntu","Chrome","22.04"],
})

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", update => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      qrcode.generate(qr, { small: true })
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== 401
      if (shouldReconnect) {
        console.log("Reconnecting...")
        startSock()
      } else {
        console.log("Logged out. Delete auth_info and restart.")
      }
    } else if (connection === "open") {
      console.log("Connected to WhatsApp")
    }
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    const text = msg.message?.conversation
    const sender = msg.key.remoteJid
    if (!text) return

    if (text.startsWith("/login")) {
      const code = text.split(" ")[1]
      if (code === process.env.BOT_PASSCODE) {
        await sock.sendMessage(sender, { text: "Authenticated" })
      } else {
        await sock.sendMessage(sender, { text: "Wrong passcode" })
      }
    }

    if (text.startsWith("/save")) {
      const [, category, ...rest] = text.split(" ")
      const data = rest.join(" ")
      await store.insertOne({
        user: sender,
        category,
        data,
        createdAt: new Date(),
      })
      await sock.sendMessage(sender, { text: `Saved under ${category}` })
    }

    if (text.startsWith("/get")) {
      const category = text.split(" ")[1]
      const found = await store.findOne({ user: sender, category })
      await sock.sendMessage(sender, {
        text: found ? found.data : "Not found",
      })
    }
  })
}

startSock()

app.listen(3000, () => console.log("Bot running on port 3000"))
