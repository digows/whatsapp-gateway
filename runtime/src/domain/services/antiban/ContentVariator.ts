import { MessageContent } from '../../entities/messaging/MessageContent.js';

export interface ContentVariatorConfig {
  maxIdenticalMessages: number;
  zeroWidthVariationEnabled: boolean;
  punctuationVariationEnabled: boolean;
}

const ZERO_WIDTH = ['\u200B', '\u200C', '\u200D', '\u2060'];

export class ContentVariator {
  constructor(private readonly config: ContentVariatorConfig) {}

  public getTrackingKey(content: MessageContent): string | null {
    if (!content.canVaryText()) {
      return null;
    }

    const text = content.getTextBody();
    if (!text) {
      return null;
    }

    return this.normalizeText(text);
  }

  public vary(
    content: MessageContent,
    seenCount: number,
  ): MessageContent {
    const originalText = content.getTextBody();
    if (!content.canVaryText() || !originalText || seenCount < this.config.maxIdenticalMessages) {
      return content;
    }

    const variationIndex = seenCount - this.config.maxIdenticalMessages;
    let text = originalText;

    if (this.config.zeroWidthVariationEnabled) {
      text = this.applyZeroWidthVariation(text, variationIndex);
    }

    if (this.config.punctuationVariationEnabled) {
      text = this.applyPunctuationVariation(text, variationIndex);
    }

    return content.withTextBody(text);
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
