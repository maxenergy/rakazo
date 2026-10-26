import { i18n } from "@lingui/core";
import type { CatalogMetadataTranslate } from "@rakazo/core";

/** Literal descriptors keep shared metadata copy visible to Lingui extraction. */
export const localizedCatalogMetadata: CatalogMetadataTranslate = (message, values) => {
  switch (message) {
    case "Subscription, cost unknown":
      return i18n._({
        id: "Subscription, cost unknown",
        message: "Subscription, cost unknown",
        values,
      });
    case "Cost unknown":
      return i18n._({ id: "Cost unknown", message: "Cost unknown", values });
    case "Free":
      return i18n._({ id: "Free", message: "Free", values });
    case "Unknown":
      return i18n._({ id: "Unknown", message: "Unknown", values });
    case "No charge":
      return i18n._({ id: "No charge", message: "No charge", values });
    case "{price} USD / million tokens":
      return i18n._({
        id: "{price} USD / million tokens",
        message: "{price} USD / million tokens",
        values,
      });
    case "Input: {price}":
      return i18n._({ id: "Input: {price}", message: "Input: {price}", values });
    case "Output: {price}":
      return i18n._({ id: "Output: {price}", message: "Output: {price}", values });
    case "Cache read: {price}":
      return i18n._({ id: "Cache read: {price}", message: "Cache read: {price}", values });
    case "Cache write: {price}":
      return i18n._({ id: "Cache write: {price}", message: "Cache write: {price}", values });
    case "Context window: {tokens}":
      return i18n._({
        id: "Context window: {tokens}",
        message: "Context window: {tokens}",
        values,
      });
    case "Maximum output tokens: {tokens}":
      return i18n._({
        id: "Maximum output tokens: {tokens}",
        message: "Maximum output tokens: {tokens}",
        values,
      });
    case "Supports reasoning":
      return i18n._({ id: "Supports reasoning", message: "Supports reasoning", values });
    case "Does not support reasoning":
      return i18n._({
        id: "Does not support reasoning",
        message: "Does not support reasoning",
        values,
      });
    default:
      return message;
  }
};
