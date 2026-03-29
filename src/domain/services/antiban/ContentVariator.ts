import { OutgoingMessageContent } from '../../../shared/contracts/gateway.js';

export interface ContentVariatorConfig {
  maxIdenticalMessages: number;
  zeroWidthVariationEnabled: boolean;
  punctuationVariationEnabled: boolean;
}

const ZERO_WIDTH = ['\u200B', '\u200C', '\u200D', '\u2060'];

export class ContentVariator {
  constructor(private readonly config: ContentVariatorConfig) {}

  public getTrackingKey(content: OutgoingMessageContent): string | null {
    if (!content.text) {
      return null;
    }

    return this.normalizeText(content.text);
  }

  public vary(
    content: OutgoingMessageContent,
    seenCount: number,
  ): OutgoingMessageContent {
    if (!content.text || seenCount < this.config.maxIdenticalMessages) {
      return content;
    }

    const variationIndex = seenCount - this.config.maxIdenticalMessages;
    let text = content.text;

    if (this.config.zeroWidthVariationEnabled) {
      text = this.applyZeroWidthVariation(text, variationIndex);
    }

    if (this.config.punctuationVariationEnabled) {
      text = this.applyPunctuationVariation(text, variationIndex);
    }

    return {
      ...content,
      text,
    };
  }

  private applyZeroWidthVariation(text: string, variationIndex: number): string {
    const variant = ZERO_WIDTH[variationIndex % ZERO_WIDTH.length];
    const words = text.split(' ');

    if (words.length <= 1) {
      return `${text}${variant}`;
    }

    const targetIndex = variationIndex % (words.length - 1);
    return words
      .map((word, index) => (index === targetIndex ? `${word}${variant}` : word))
      .join(' ');
  }

  private applyPunctuationVariation(text: string, variationIndex: number): string {
    const patterns = ['', '.', '..', ' !'];
    const suffix = patterns[variationIndex % patterns.length];

    if (!suffix) {
      return text;
    }

    if (text.endsWith('.') || text.endsWith('!') || text.endsWith('?')) {
      return `${text}${suffix.trimStart()}`;
    }

    return `${text}${suffix}`;
  }

  private normalizeText(text: string): string {
    return text.trim().replace(/\s+/g, ' ').toLowerCase();
  }
}
