import { createError, defineEventHandler, readMultipartFormData, setHeader } from 'h3'
import { processArchive } from '../utils/process-archive'

export default defineEventHandler(async (event) => {
  const files = await readMultipartFormData(event)
  const archive = files?.find(file => file.name === 'archive')

  if (!archive?.data || !archive.filename) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Attach a ZIP file in the archive field.'
    })
  }

  if (!archive.filename.toLowerCase().endsWith('.zip')) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Only .zip uploads are supported.'
    })
  }

  try {
    const result = await processArchive({
      archiveBuffer: Buffer.isBuffer(archive.data) ? archive.data : Buffer.from(archive.data),
      originalFilename: archive.filename
    })

    setHeader(event, 'Content-Type', 'application/zip')
    setHeader(event, 'Content-Disposition', `attachment; filename="${result.outputFilename}"`)
    setHeader(event, 'X-Conversion-Stats', encodeURIComponent(JSON.stringify(result.stats)))

    return result.outputZipBuffer
  }
  catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : 'Archive conversion failed.'
    })
  }
})
