/*
  Copyright 2018 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

import { assert } from "workbox-core/_private/assert.js";
import { logger } from "workbox-core/_private/logger.js";
import { WorkboxError } from "workbox-core/_private/WorkboxError.js";

import { Strategy, StrategyOptions } from "./Strategy.js";
import { StrategyHandler } from "./StrategyHandler.js";
import { messages } from "./utils/messages.js";
import "./_version.js";

// window.scopus.platform.serviceWorker.strategies.DedupRequests

interface DedupRequestsOptions extends StrategyOptions {
  networkTimeoutSeconds?: number;
  offlineSupport?: boolean;
}

/**
 * Deduplicates two or more API requests being done at the same time.
 *
 * If the request fails, and there is no cache match, this will throw
 * a `WorkboxError` exception.
 *
 * @extends module:workbox-core.Strategy
 * @memberof module:workbox-strategies
 */
export class DedupRequests extends Strategy {
  /**
   * Temporary cache for requests being done at the same time.
   */
  private _memoryCache = new Map<string, Promise<Response | undefined>>();

  private _offlineSupport: boolean;
  private _networkTimeoutSeconds: number;

  constructor(options: DedupRequestsOptions = {}) {
    super(options);
    this._offlineSupport = options.offlineSupport || false;
    this._networkTimeoutSeconds = options.networkTimeoutSeconds || 0;
  }

  private _getRequestKey(request: Request) {
    return `${request.method} ${request.url}`;
  }

  private _wait(seconds: number) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  private _fetchAndCachesPutWithTimeout({
    logs,
    request,
    handler,
  }: {
    logs: any[];
    request: Request;
    handler: StrategyHandler;
  }) {
    let done = false;

    const fallbackToCache = () => {
      return handler.cacheMatch(request).then((response) => {
        if (done || !this._offlineSupport) return;

        if (process.env.NODE_ENV !== "production") {
          if (response) {
            logs.push(`Got response from '${this.cacheName}' cache`);
          } else {
            logs.push(`No response from '${this.cacheName}' cache`);
          }
        }

        return response;
      });
    };

    const promises = [
      handler
        .fetchAndCachePut(request)
        .then((response) => {
          if (done) return;

          if (process.env.NODE_ENV !== "production") {
            logs.push(`Got response from network.`);
          }

          return response;
        })
        .catch(() => {
          if (done) return;

          if (process.env.NODE_ENV !== "production") {
            logs.push(`Network request failed.`);
          }

          return fallbackToCache();
        }),
    ];

    if (this._networkTimeoutSeconds) {
      promises.push(
        this._wait(this._networkTimeoutSeconds).then(() => {
          if (done) return;

          if (process.env.NODE_ENV !== "production") {
            logs.push(
              `Timing out the network response at ${this._networkTimeoutSeconds} seconds.`
            );
          }

          return fallbackToCache();
        })
      );
    }

    const responsePromise = Promise.race(promises);

    responsePromise.finally(() => (done = true));

    this._memoryCache.set(
      this._getRequestKey(request),
      responsePromise.then(
        (response) => response?.clone(),
        () => undefined
      )
    );

    return responsePromise;
  }

  async _handle(request: Request, handler: StrategyHandler): Promise<Response> {
    const logs = [];

    if (process.env.NODE_ENV !== "production") {
      assert!.isInstance(request, Request, {
        moduleName: "workbox-strategies",
        className: "DedupRequests",
        funcName: "makeRequest",
        paramName: "request",
      });
    }

    let response = await this._memoryCache
      .get(this._getRequestKey(request))
      ?.catch(() => undefined);

    let error;
    if (!response) {
      if (process.env.NODE_ENV !== "production") {
        logs.push(
          `No response found in the memory cache. Will respond with a network request or '${this.cacheName}' cache.`
        );
      }

      try {
        response = await this._fetchAndCachesPutWithTimeout({
          logs,
          request,
          handler,
        });
      } catch (err) {
        error = err;
      }

      if (process.env.NODE_ENV !== "production") {
        if (!response) {
          logs.push(
            `Unable to get a response from the network, memory cache or '${this.cacheName}' cache.`
          );
        }
      }
    } else {
      if (process.env.NODE_ENV !== "production") {
        logs.push(`Found a cached response in the memory cache.`);
      }
    }

    if (process.env.NODE_ENV !== "production") {
      logger.groupCollapsed(messages.strategyStart("DedupRequests", request));
      for (const log of logs) {
        logger.log(log);
      }
      messages.printFinalResponse(response);
      logger.groupEnd();
    }

    if (!response) {
      throw new WorkboxError("no-response", { url: request.url, error });
    }

    this._memoryCache.delete(this._getRequestKey(request));

    return response;
  }
}
