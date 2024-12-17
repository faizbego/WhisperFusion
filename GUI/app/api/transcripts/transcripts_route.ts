import { NextResponse } from 'next/server'

export async function GET() {
  try {
    // This is a mock implementation. Replace with actual logic to fetch transcripts.
    const transcripts = [
      { type: 'unrevised', content: 'This is an unrevised transcript.' },
      { type: 'revised', content: 'This is a revised transcript.' },
      { type: 'voice', content: 'This is a generated voice output transcript.' },
    ]

    return NextResponse.json(transcripts)
  } catch (error) {
    console.error('Error fetching transcripts:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

