export interface ActivationContext {
  readonly isFromBot: boolean;
  readonly mentionsBot: boolean;
  readonly isReplyToBot: boolean;
}

export const isActivationMessage = (context: ActivationContext): boolean =>
  !context.isFromBot && (context.mentionsBot || context.isReplyToBot);

export const shouldTreatAsSteering = (
  context: ActivationContext,
  runInProgress: boolean,
): boolean => runInProgress && isActivationMessage(context);
