import { z } from '@hono/zod-openapi'

export const RateLimitSpec = z.object( {
  // If any of these fields are omitted the system will treat that dimension as "unlimited".
  tokensPerMinute: z.number( { error: 'tokensPerMinute must be a number' } ).int( 'tokensPerMinute must be an integer' ).positive( 'tokensPerMinute must be > 0' ).optional(),
  requestsPerMinute: z.number( { error: 'requestsPerMinute must be a number' } ).int( 'requestsPerMinute must be an integer' ).positive( 'requestsPerMinute must be > 0' ).optional(),
  requestsPerDay: z.number( { error: 'requestsPerDay must be a number' } ).int( 'requestsPerDay must be an integer' ).positive( 'requestsPerDay must be > 0' ).optional(),
  // STT-specific: maximum seconds of audio that can be processed
  audioSecondsPerHour: z.number( { error: 'audioSecondsPerHour must be a number' } ).int( 'audioSecondsPerHour must be an integer' ).positive( 'audioSecondsPerHour must be > 0' ).optional().describe( 'Maximum seconds of audio that can be processed per hour (STT)' ),
  audioSecondsPerDay: z.number( { error: 'audioSecondsPerDay must be a number' } ).int( 'audioSecondsPerDay must be an integer' ).positive( 'audioSecondsPerDay must be > 0' ).optional().describe( 'Maximum seconds of audio that can be processed per day (STT)' ),
  tokensPerDay: z.number( { error: 'tokensPerDay must be a number' } ).int( 'tokensPerDay must be an integer' ).positive( 'tokensPerDay must be > 0' ).optional().describe( 'Maximum tokens per day' ),
} ).strict()

export const RateLimitSchema = RateLimitSpec.optional()

export const WebSearchRateLimitSchema = z.object( {
  requestsPerMinute: z.number( { error: 'requestsPerMinute must be a number' } ).int( 'requestsPerMinute must be an integer' ).positive( 'requestsPerMinute must be > 0' ).optional(),
  requestsPerDay: z.number( { error: 'requestsPerDay must be a number' } ).int( 'requestsPerDay must be an integer' ).positive( 'requestsPerDay must be > 0' ).optional(),
  requestsPerMonth: z.number( { error: 'requestsPerMonth must be a number' } ).int( 'requestsPerMonth must be an integer' ).positive( 'requestsPerMonth must be > 0' ).optional(),
} ).optional()
