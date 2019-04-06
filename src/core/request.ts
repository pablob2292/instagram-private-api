import { IgApiClient } from '../client';
import { random } from 'lodash';
import * as request from 'request-promise';
import { Options } from 'request';
import { ActionSpamError, AuthenticationError, CheckpointError, SentryBlockError } from '../exceptions';
import { plainToClass } from 'class-transformer';
import { CheckpointResponse } from '../responses';
import hmac = require('crypto-js/hmac-sha256');

type Payload = { [key: string]: any } | string;

interface SignedPost {
  signed_body: string;
  ig_sig_key_version: string;
}

export class Request {
  constructor(private client: IgApiClient) {}

  private static requestTransform(body, response, resolveWithFullResponse) {
    // Sometimes we have numbers greater than Number.MAX_SAFE_INTEGER in json response
    // To handle it we just wrap numbers with length > 15 it double quotes to get strings instead
    response.body = JSON.parse(body.replace(/([\[:])?(-?[\d.]{15,})(\s*?[,}\]])/gi, `$1"$2"$3`));
    return resolveWithFullResponse ? response : response.body;
  }

  private static errorMiddleware(response) {
    const json = response.body;
    if (json.spam) {
      throw new ActionSpamError(json);
    }
    if (json.message === 'challenge_required') {
      const checkpointResponse = plainToClass(CheckpointResponse, json as CheckpointResponse);
      throw new CheckpointError(checkpointResponse);
    }
    if (json.message === 'login_required') {
      throw new AuthenticationError('Login required to process this request');
    }
    if (json.error_type === 'sentry_block') {
      throw new SentryBlockError(json);
    }
  }

  public async send(userOptions: Options): Promise<any> {
    const baseOptions = {
      baseUrl: 'https://i.instagram.com/',
      resolveWithFullResponse: true,
      proxy: this.client.state.proxyUrl,
      simple: false,
      transform: Request.requestTransform,
      jar: this.client.state.cookieJar,
      strictSSL: false,
      gzip: true,
    };
    const requestOptions = Object.assign(baseOptions, userOptions, {
      headers: this.getDefaultHeaders(userOptions.headers),
    });
    const response = await request(requestOptions);
    if (response.body.status === 'ok') {
      return response;
    }
    return Request.errorMiddleware(response);
  }

  public sign(payload: Payload): string {
    const json = typeof payload === 'object' ? JSON.stringify(payload) : payload;
    const signature = hmac(json, this.client.state.signatureKey).toString();
    return `${signature}.${json}`;
  }

  public signPost(payload: Payload): SignedPost {
    if (typeof payload === 'object') {
      payload._csrftoken = this.client.state.CSRFToken;
    }
    const signed_body = this.sign(payload);
    return {
      ig_sig_key_version: this.client.state.signatureVersion,
      signed_body,
    };
  }

  private getDefaultHeaders(userHeaders = {}) {
    return {
      'X-FB-HTTP-Engine': 'Liger',
      'X-IG-Connection-Type': 'WIFI',
      'X-IG-Capabilities': '3brTPw==',
      'X-IG-Connection-Speed': `${random(1000, 3700)}kbps`,
      'X-IG-Bandwidth-Speed-KBPS': '-1.000',
      'X-IG-Bandwidth-TotalBytes-B': '0',
      'X-IG-Bandwidth-TotalTime-MS': '0',
      Host: 'i.instagram.com',
      Accept: '*/*',
      'Accept-Encoding': 'gzip,deflate',
      Connection: 'Keep-Alive',
      'User-Agent': this.client.state.appUserAgent,
      'X-IG-App-ID': this.client.state.fbAnalyticsApplicationId,
      'Accept-Language': this.client.state.language.replace('_', '-'),
      ...userHeaders,
    };
  }
}
