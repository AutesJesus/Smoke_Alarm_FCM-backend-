import { createClient } from 'npm:@supabase/supabase-js@2'
import { JWT } from 'npm:google-auth-library@9'
import serviceAccount from './service-account.json' with { type: 'json' }

interface Notification {
  id: string
  user_id: string
  body: string
}

interface WebhookPayload {
  type: 'INSERT'
  table: string
  record: Notification
  schema: 'public'
}

interface SmokeLog {
  id: string
  device_id: string
  detected_at: string
  status: boolean
}

interface SmokeLogWebhookPayload {
  type: 'INSERT'
  table: string
  record: SmokeLog
  schema: 'public'
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  const payload: SmokeLogWebhookPayload = await req.json()

  // Only handle INSERTs on smoke_logs
  if (payload.type !== 'INSERT' || payload.table !== 'smoke_logs') {
    return new Response(JSON.stringify({ message: 'Not a smoke_logs insert event.' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }

  // Fetch the device's FCM token
  const { data: device } = await supabase
    .from('device')
    .select('fcm_token, area, unit_no')
    .eq('id', payload.record.device_id)
    .single()

  if (!device || !device.fcm_token) {
    return new Response(JSON.stringify({ error: 'Device FCM token not found.' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 404,
    })
  }

  const fcmToken = device.fcm_token as string

  const accessToken = await getAccessToken({
    clientEmail: serviceAccount.client_email,
    privateKey: serviceAccount.private_key,
  })

  // Ensure detected_at is parsed as UTC, handling Postgres format
  let detectedAtString = payload.record.detected_at
    .replace(' ', 'T')
    .replace(/\+00$/, 'Z');
  if (!detectedAtString.endsWith('Z')) {
    detectedAtString += 'Z';
  }
  const detectedAtUTC = new Date(detectedAtString);
  // Format as hh:mm AM/PM, MMM DD, YYYY in Asia/Manila timezone
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    timeZone: 'Asia/Manila',
  };
  const formattedTime = detectedAtUTC.toLocaleString('en-US', options);

  const notifBody = `A SMOKE HAS BEEN DETECTED\nAT: ${device.area || 'Unknown'}\nON: ${formattedTime}`

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token: fcmToken,
          notification: {
            title: `Smoke Alert!`,
            body: notifBody,
          },
        },
      }),
    }
  )

  const resData = await res.json()
  if (res.status < 200 || 299 < res.status) {
    throw resData
  }

  return new Response(JSON.stringify(resData), {
    headers: { 'Content-Type': 'application/json' },
  })
})

const getAccessToken = ({
  clientEmail,
  privateKey,
}: {
  clientEmail: string
  privateKey: string
}): Promise<string> => {
  return new Promise((resolve, reject) => {
    const jwtClient = new JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    })
    jwtClient.authorize((err, tokens) => {
      if (err) {
        reject(err)
        return
      }
      resolve(tokens!.access_token!)
    })
  })
}