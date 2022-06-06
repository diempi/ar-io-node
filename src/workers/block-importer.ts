import * as EventEmitter from 'events';
import * as promClient from 'prom-client';
import * as winston from 'winston';
import wait from 'wait';

import {
  JsonTransaction,
  JsonBlock,
  IChainSource,
  IChainDatabase
} from '../types';

export class BlockImporter {
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private chainDatabase: IChainDatabase;
  private chainSource: IChainSource;
  private maxChainHeight: number;
  private shouldRun: boolean;
  private heightPollingDelay: number;

  // Metrics
  private forksCounter: promClient.Counter<string>;
  private lastForkDepthGauge: promClient.Gauge<string>;
  private blocksImportedCounter: promClient.Counter<string>;
  private transactionsImportedCounter: promClient.Counter<string>;
  private blockImportErrorsCounter: promClient.Counter<string>;

  constructor({
    log,
    metricsRegistry,
    chainSource,
    chainDatabase,
    eventEmitter
  }: {
    log: winston.Logger;
    metricsRegistry: promClient.Registry;
    chainSource: IChainSource;
    chainDatabase: IChainDatabase;
    eventEmitter: EventEmitter;
  }) {
    this.log = log.child({ module: 'block-importer' });
    this.chainSource = chainSource;
    this.chainDatabase = chainDatabase;
    this.eventEmitter = eventEmitter;
    this.maxChainHeight = 0;
    this.heightPollingDelay = 5000;
    this.shouldRun = false;

    this.forksCounter = new promClient.Counter({
      name: 'forks_total',
      help: 'Number of forks observed'
    });
    metricsRegistry.registerMetric(this.forksCounter);

    this.lastForkDepthGauge = new promClient.Gauge({
      name: 'last_fork_depth',
      help: 'Depth of the last observed fork'
    });
    metricsRegistry.registerMetric(this.lastForkDepthGauge);

    this.blocksImportedCounter = new promClient.Counter({
      name: 'blocks_imported_total',
      help: 'Number of blocks imported'
    });
    metricsRegistry.registerMetric(this.blocksImportedCounter);

    this.transactionsImportedCounter = new promClient.Counter({
      name: 'transactions_imported_total',
      help: 'Number of transactions imported'
    });
    metricsRegistry.registerMetric(this.transactionsImportedCounter);

    this.blockImportErrorsCounter = new promClient.Counter({
      name: 'block_import_errors_total',
      help: 'Number of block import errors'
    });
    metricsRegistry.registerMetric(this.blockImportErrorsCounter);
  }

  private async getBlockOrForkedBlock(
    height: number,
    forkDepth = 0
  ): Promise<{
    block: JsonBlock;
    txs: JsonTransaction[];
    missingTxIds: string[];
  }> {
    const { block, txs, missingTxIds } = await this.chainSource.getBlockAndTxs(
      height
    );

    // Retrieve expected previous block hash from the DB
    const previousHeight = height - 1;
    const previousDbBlockHash =
      await this.chainDatabase.getNewBlockHashByHeight(previousHeight);

    // Stop importing if unable to find the previous block in the DB
    if (height != 0 && !previousDbBlockHash) {
      this.log.error(
        'Missing previous block hash. Stopping block import process.'
      );
      this.shouldRun = false;
      throw new Error('Missing previous block hash missing');
    }

    if (block.previous_block !== previousDbBlockHash) {
      this.log.info(
        `Fork detected at height ${height}. Reseting index to height ${previousHeight}...`
      );
      this.chainDatabase.resetToHeight(previousHeight);
      return this.getBlockOrForkedBlock(previousHeight, forkDepth + 1);
    }

    // Record fork count and depth metrics
    if (forkDepth > 0) {
      this.forksCounter.inc();
      this.lastForkDepthGauge.set(forkDepth);
    }

    return { block, txs, missingTxIds };
  }

  private async importBlock(height: number) {
    const { block, txs, missingTxIds } = await this.getBlockOrForkedBlock(
      height
    );

    // Emit events
    this.eventEmitter.emit('block', block);
    txs.forEach((tx) => {
      this.eventEmitter.emit('block-tx', tx);
    });

    this.chainDatabase.insertBlockAndTxs(block, txs, missingTxIds);

    // Record import count metrics
    this.blocksImportedCounter.inc();
    this.transactionsImportedCounter.inc(txs.length);
  }

  private async getNextHeight() {
    // Set maxChainHeight on first run
    if (this.maxChainHeight === 0) {
      this.maxChainHeight = await this.chainSource.getHeight();
    }

    const dbHeight = await this.chainDatabase.getMaxHeight();

    // Wait for the next block if the DB is in sync with the chain
    while (dbHeight >= this.maxChainHeight) {
      this.log.info(`Polling for block after height ${dbHeight}...`);
      await wait(this.heightPollingDelay);
      this.maxChainHeight = await this.chainSource.getHeight();
    }

    return dbHeight + 1;
  }

  public async start() {
    this.shouldRun = true;
    let nextHeight;

    // Run until stop is called or an unrecoverable error occurs
    while (this.shouldRun) {
      try {
        nextHeight = await this.getNextHeight();
        this.log.info(`Importing block at height ${nextHeight}`);

        await this.importBlock(nextHeight);
      } catch (error) {
        this.log.error(`Error importing block at height ${nextHeight}`, error);
        this.blockImportErrorsCounter.inc();
      }
    }
  }

  public async stop() {
    this.shouldRun = false;
  }
}
