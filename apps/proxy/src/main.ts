import { fetchResponse, protos, SecretKeys } from '@flyxc/common';
import express, { Request, Response } from 'express';

const app = express().use(express.raw());

app.post('/get', async (req: Request, res: Response) => {
  const r = protos.Request.fromBinary(req.body);

  if (r.key != SecretKeys.PROXY_KEY) {
    return res.status(400).send(`[proxy] Invalid key`);
  }

  try {
    const response = await fetchResponse(r.url, {
      retry: r.retry,
      timeoutS: r.timeoutS,
      retryOnTimeout: r.retryOnTimeout,
    });

    return res.status(response.status).send(await response.text());
  } catch (e) {
    return res.status(500).send(`[proxy] ${JSON.stringify(e)}`);
  }
});

const port = process.env.PORT || 80;

app.listen(port, () => console.info(`Started server on port ${port}.`));
