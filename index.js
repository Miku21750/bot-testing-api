import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys"
import P from "pino"
import QRCode from "qrcode"

async function start() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_demo')
    const sock = makeWASocket({
        auth: state,
        logger: P({level: info}),
        getMessage: async (key) => undefined
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr} = update

        if(qr) {
            console.log(await QRCode.toString(qr, { type: 'terminal'}))
        }

        if (connection === 'close'){
            const statusCode = lastDisconnect?.error?.output?.statusCode
            if(statusCode === DisconnectReason.restartRequired){
                start()
            }
        }

        if(connection === 'open'){
            console.log('✅ connected')
        }
    })

    sock.ev.on('messages.upsert', async ({type, messages}) => {
        if(type !== 'notify') return
        for(const msg of messages){

        }
    })
}
start()