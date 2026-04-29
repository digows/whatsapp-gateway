import { WAMessageStatus } from 'baileys';

const ACK_LEVELS = {
  server: WAMessageStatus.SERVER_ACK,
  delivery: WAMessageStatus.DELIVERY_ACK,
  read: WAMessageStatus.READ,
  played: WAMessageStatus.PLAYED,
};

const STATUS_NAMES = {
  [WAMessageStatus.ERROR]: 'ERROR',
  [WAMessageStatus.PENDING]: 'PENDING',
  [WAMessageStatus.SERVER_ACK]: 'SERVER_ACK',
  [WAMessageStatus.DELIVERY_ACK]: 'DELIVERY_ACK',
  [WAMessageStatus.READ]: 'READ',
  [WAMessageStatus.PLAYED]: 'PLAYED',
};

function isMatchingMessage(updateKey, expectedKey)
{
  if (!updateKey?.id || !expectedKey?.id)
  {
    return false;
  }

  if (updateKey.id !== expectedKey.id)
  {
    return false;
  }

  if (!expectedKey.remoteJid || !updateKey.remoteJid)
  {
    return true;
  }

  return updateKey.remoteJid === expectedKey.remoteJid;
}

function getAckStatusTarget(ackLevel)
{
  const target = ACK_LEVELS[ackLevel];
  if (!target)
  {
    throw new Error(`Unsupported ack level "${ackLevel}". Use one of: ${Object.keys(ACK_LEVELS).join(', ')}.`);
  }

  return target;
}

function formatStatus(status)
{
  if (typeof status !== 'number')
  {
    return 'UNKNOWN';
  }

  return STATUS_NAMES[status] || `STATUS_${status}`;
}

export async function waitForAck(socket, messageKey, options = {})
{
  const ackLevel = options.ackLevel || 'server';
  const timeoutMs = Number(options.timeoutMs || 30000);
  const targetStatus = getAckStatusTarget(ackLevel);

  return await new Promise((resolve, reject) =>
  {
    let settled = false;
    let lastStatus;

    const finish = callback =>
    {
      if (settled)
      {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      socket.ev.off('messages.update', onMessageUpdates);
      callback();
    };

    const onMessageUpdates = updates =>
    {
      for (const update of updates)
      {
        if (!isMatchingMessage(update?.key, messageKey))
        {
          continue;
        }

        const status = update?.update?.status;
        if (typeof status !== 'number')
        {
          continue;
        }

        if (status !== lastStatus)
        {
          lastStatus = status;
          console.log(`[ack] ${messageKey.id} -> ${formatStatus(status)}`);
        }

        if (status === WAMessageStatus.ERROR)
        {
          finish(() => reject(new Error(`Message ${messageKey.id} moved to ERROR status.`)));
          return;
        }

        if (status >= targetStatus)
        {
          finish(() => resolve({
            ok: true,
            status,
            statusName: formatStatus(status),
          }));
          return;
        }
      }
    };

    const timeoutHandle = setTimeout(() =>
    {
      finish(() => reject(new Error(`Timeout waiting for ${ackLevel.toUpperCase()} ACK for message ${messageKey.id}.`)));
    }, timeoutMs);

    socket.ev.on('messages.update', onMessageUpdates);
  });
}
