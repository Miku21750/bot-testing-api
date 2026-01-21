if (process.env.NODE_ENV !== 'production') {
  const dotenv = await import('dotenv')
  dotenv.config()
}

export function requireBearer(req, res, next) {
    const expected = process.env.API_TOKEN
    if(!expected) return res.status(500).json({ ok: false, message: 'API_TOKEN not set' })

    const h = req.headers.authorization || ''
    const token = h.startsWith('Bearer ') ? h.slice(7) : null
    if(token !== expected) return res.status(401).json({ ok: false, message: 'Unauthorized' })
    next()
}