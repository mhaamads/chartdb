import React, { useCallback, useMemo, useState } from 'react';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/dialog/dialog';
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from '@/components/tabs/tabs';
import { Button } from '@/components/button/button';
import { Input } from '@/components/input/input';
import { Label } from '@/components/label/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/select/select';
import { useDialog } from '@/hooks/use-dialog';
import { useAIConfig } from '@/hooks/use-ai-config';
import { useToast } from '@/components/toast/use-toast';
import type { BaseDialogProps } from '../common/base-dialog-props';
import {
    AI_MODELS,
    PROVIDER_API_KEY_HINTS,
    PROVIDER_LABELS,
    getDefaultBaseUrl,
    getModel,
    getModelsForProvider,
} from '@/lib/ai/models';
import type { AIProvider, AISafetyMode } from '@/lib/ai/types';
import { AI_PROVIDERS, isLocalProvider } from '@/lib/ai/types';
import { listLMStudioModels } from '@/lib/ai/providers/lmstudio';
import { buildDeepSeekModelsUrl } from '@/lib/ai/providers/deepseek';
import {
    AlertTriangle,
    Eye,
    EyeOff,
    Loader2,
    Sparkles,
    Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type AISettingsDialogProps = BaseDialogProps;

export const AISettingsDialog: React.FC<AISettingsDialogProps> = ({
    dialog,
}) => {
    const { t } = useTranslation();
    const { closeAISettingsDialog } = useDialog();
    const { toast } = useToast();
    const config = useAIConfig();
    const [tab, setTab] = useState<'providers' | 'behavior' | 'privacy'>(
        'providers'
    );
    const [revealed, setRevealed] = useState<Record<AIProvider, boolean>>(() =>
        AI_PROVIDERS.reduce(
            (acc, p) => {
                acc[p] = false;
                return acc;
            },
            {} as Record<AIProvider, boolean>
        )
    );
    const [testing, setTesting] = useState<AIProvider | null>(null);
    const [draftKeys, setDraftKeys] = useState<Record<AIProvider, string>>(
        () => ({ ...config.apiKeys })
    );
    const [confirmingClear, setConfirmingClear] = useState(false);

    // Keep local draft in sync if external load completes after open.
    React.useEffect(() => {
        if (config.ready) setDraftKeys({ ...config.apiKeys });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [config.ready]);

    const handleSaveKey = useCallback(
        async (provider: AIProvider) => {
            await config.setApiKey(provider, draftKeys[provider]);
            toast({
                title: t('ai_settings.toast_key_saved_title', {
                    defaultValue: 'API key saved',
                }),
                description: t('ai_settings.toast_key_saved_desc', {
                    provider: PROVIDER_LABELS[provider],
                    defaultValue: `Encrypted and stored locally for {{provider}}.`,
                }),
            });
        },
        [config, draftKeys, t, toast]
    );

    const handleTest = useCallback(
        async (provider: AIProvider) => {
            const key = draftKeys[provider]?.trim() ?? '';
            const local = isLocalProvider(provider);
            if (!key && !local) {
                toast({
                    variant: 'destructive',
                    title: t('ai_settings.toast_no_key_title', {
                        defaultValue: 'No API key',
                    }),
                    description: t('ai_settings.toast_no_key_desc', {
                        defaultValue: 'Enter an API key first.',
                    }),
                });
                return;
            }
            setTesting(provider);
            try {
                const baseUrl = config.baseUrlByProvider[provider];
                await pingProvider(provider, key, baseUrl);
                toast({
                    title: t('ai_settings.toast_test_ok_title', {
                        defaultValue: 'Connection OK',
                    }),
                    description: t('ai_settings.toast_test_ok_desc', {
                        defaultValue:
                            'Provider responded successfully. You can save this key.',
                    }),
                });
            } catch (err) {
                toast({
                    variant: 'destructive',
                    title: t('ai_settings.toast_test_fail_title', {
                        defaultValue: 'Connection failed',
                    }),
                    description:
                        err instanceof Error ? err.message : String(err),
                });
            } finally {
                setTesting(null);
            }
        },
        [draftKeys, config.baseUrlByProvider, t, toast]
    );

    const handleClearAll = useCallback(async () => {
        await config.clearAll();
        setDraftKeys(
            AI_PROVIDERS.reduce(
                (acc, p) => {
                    acc[p] = '';
                    return acc;
                },
                {} as Record<AIProvider, string>
            )
        );
        setConfirmingClear(false);
        toast({
            title: t('ai_settings.toast_cleared_title', {
                defaultValue: 'AI data cleared',
            }),
            description: t('ai_settings.toast_cleared_desc', {
                defaultValue:
                    'All API keys and assistant settings have been removed from this device.',
            }),
        });
    }, [config, t, toast]);

    return (
        <Dialog
            {...dialog}
            onOpenChange={(open) => {
                if (!open) closeAISettingsDialog();
            }}
        >
            <DialogContent
                className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl"
                showClose
            >
                <DialogHeader className="shrink-0 border-b px-6 py-4">
                    <DialogTitle className="flex items-center gap-2 text-base">
                        <Sparkles className="size-4 text-amber-500" />
                        {t('ai_settings.title', {
                            defaultValue: 'AI Assistant Settings',
                        })}
                    </DialogTitle>
                    <DialogDescription>
                        {t('ai_settings.description', {
                            defaultValue:
                                'Bring your own API key. Keys are encrypted at rest and never leave your browser unless you make a request.',
                        })}
                    </DialogDescription>
                </DialogHeader>

                <Tabs
                    value={tab}
                    onValueChange={(v) => setTab(v as typeof tab)}
                    className="flex min-h-0 flex-1 flex-col"
                >
                    <div className="shrink-0 border-b px-6 py-2">
                        <TabsList>
                            <TabsTrigger value="providers">
                                {t('ai_settings.tab_providers', {
                                    defaultValue: 'Providers',
                                })}
                            </TabsTrigger>
                            <TabsTrigger value="behavior">
                                {t('ai_settings.tab_behavior', {
                                    defaultValue: 'Behavior',
                                })}
                            </TabsTrigger>
                            <TabsTrigger value="privacy">
                                {t('ai_settings.tab_privacy', {
                                    defaultValue: 'Privacy',
                                })}
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    <div className="min-h-0 flex-1 overflow-y-auto">
                        <div className="px-6 py-5">
                            <TabsContent
                                value="providers"
                                className="mt-0 flex flex-col gap-6"
                            >
                                <ActiveProviderRow />
                                {AI_PROVIDERS.map((p) => (
                                    <ProviderSection
                                        key={p}
                                        provider={p}
                                        draftKey={draftKeys[p]}
                                        onDraftChange={(v) =>
                                            setDraftKeys((prev) => ({
                                                ...prev,
                                                [p]: v,
                                            }))
                                        }
                                        revealed={revealed[p]}
                                        onToggleReveal={() =>
                                            setRevealed((prev) => ({
                                                ...prev,
                                                [p]: !prev[p],
                                            }))
                                        }
                                        testing={testing === p}
                                        onTest={() => handleTest(p)}
                                        onSave={() => handleSaveKey(p)}
                                    />
                                ))}
                            </TabsContent>

                            <TabsContent
                                value="behavior"
                                className="mt-0 flex flex-col gap-6"
                            >
                                <BehaviorSection />
                            </TabsContent>

                            <TabsContent
                                value="privacy"
                                className="mt-0 flex flex-col gap-4"
                            >
                                <PrivacySection
                                    confirming={confirmingClear}
                                    onRequestClear={() =>
                                        setConfirmingClear(true)
                                    }
                                    onCancelClear={() =>
                                        setConfirmingClear(false)
                                    }
                                    onConfirmClear={handleClearAll}
                                />
                            </TabsContent>
                        </div>
                    </div>
                </Tabs>

                <DialogFooter className="shrink-0 border-t px-6 py-3">
                    <DialogClose asChild>
                        <Button variant="secondary">
                            {t('ai_settings.close', { defaultValue: 'Close' })}
                        </Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

const ActiveProviderRow: React.FC = () => {
    const { t } = useTranslation();
    const { provider, setProvider, modelByProvider, setModel } = useAIConfig();
    const models = useMemo(() => getModelsForProvider(provider), [provider]);

    return (
        <div className="rounded-md border bg-muted/30 p-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('ai_settings.active_provider', {
                    defaultValue: 'Active provider',
                })}
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
                <div className="flex-1">
                    <Label className="mb-1.5 block text-xs text-muted-foreground">
                        {t('ai_settings.provider_label', {
                            defaultValue: 'Provider',
                        })}
                    </Label>
                    <Select
                        value={provider}
                        onValueChange={(v) => setProvider(v as AIProvider)}
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {AI_PROVIDERS.map((p) => (
                                <SelectItem key={p} value={p}>
                                    {PROVIDER_LABELS[p]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex-1">
                    <Label className="mb-1.5 block text-xs text-muted-foreground">
                        {t('ai_settings.model_label', {
                            defaultValue: 'Model',
                        })}
                    </Label>
                    <Select
                        value={modelByProvider[provider]}
                        onValueChange={(v) => setModel(provider, v)}
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {models.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                    {m.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>
        </div>
    );
};

interface ProviderSectionProps {
    provider: AIProvider;
    draftKey: string;
    onDraftChange: (v: string) => void;
    revealed: boolean;
    onToggleReveal: () => void;
    testing: boolean;
    onTest: () => void;
    onSave: () => void;
}

const ProviderSection: React.FC<ProviderSectionProps> = ({
    provider,
    draftKey,
    onDraftChange,
    revealed,
    onToggleReveal,
    testing,
    onTest,
    onSave,
}) => {
    const { t } = useTranslation();
    const {
        apiKeys,
        modelByProvider,
        setModel,
        baseUrlByProvider,
        setBaseUrl,
    } = useAIConfig();
    const savedKey = apiKeys[provider];
    const dirty = draftKey !== savedKey;
    const currentModel = getModel(modelByProvider[provider]);
    const local = isLocalProvider(provider);
    const baseUrl =
        baseUrlByProvider[provider] ?? getDefaultBaseUrl(provider) ?? '';
    const [draftBaseUrl, setDraftBaseUrl] = useState(baseUrl);
    const [discoveredModels, setDiscoveredModels] = useState<string[] | null>(
        null
    );
    const [discovering, setDiscovering] = useState(false);
    const { toast } = useToast();

    // Keep the input in sync if the saved base URL changes externally.
    React.useEffect(() => {
        setDraftBaseUrl(baseUrl);
    }, [baseUrl]);

    const handleFetchModels = useCallback(async () => {
        if (provider !== 'lmstudio') return;
        setDiscovering(true);
        try {
            const url = draftBaseUrl.trim() || undefined;
            const models = await listLMStudioModels(
                url,
                draftKey.trim() || undefined
            );
            if (models.length === 0) {
                toast({
                    variant: 'destructive',
                    title: t('ai_settings.lmstudio_no_models_title', {
                        defaultValue: 'No models loaded',
                    }),
                    description: t('ai_settings.lmstudio_no_models_desc', {
                        defaultValue:
                            'LM Studio is reachable but no model is currently loaded. Load one in the LM Studio app.',
                    }),
                });
                setDiscoveredModels([]);
                return;
            }
            setDiscoveredModels(models.map((m) => m.id));
            // Auto-select the first available model when the current
            // selection isn't present locally.
            const currentId = modelByProvider[provider];
            if (!models.find((m) => m.id === currentId)) {
                setModel(provider, models[0].id);
            }
        } catch (err) {
            toast({
                variant: 'destructive',
                title: t('ai_settings.lmstudio_fetch_fail_title', {
                    defaultValue: 'Could not reach LM Studio',
                }),
                description: err instanceof Error ? err.message : String(err),
            });
        } finally {
            setDiscovering(false);
        }
    }, [provider, draftBaseUrl, draftKey, modelByProvider, setModel, t, toast]);

    return (
        <div className="flex flex-col gap-3 rounded-md border p-4">
            <div className="flex items-center justify-between">
                <div className="flex flex-col">
                    <span className="text-sm font-semibold">
                        {PROVIDER_LABELS[provider]}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        {PROVIDER_API_KEY_HINTS[provider]}
                    </span>
                </div>
                {local ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-600 dark:text-sky-400">
                        <span className="size-1.5 rounded-full bg-sky-500" />
                        {t('ai_settings.local_provider', {
                            defaultValue: 'Local',
                        })}
                    </span>
                ) : savedKey ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        <span className="size-1.5 rounded-full bg-emerald-500" />
                        {t('ai_settings.key_configured', {
                            defaultValue: 'Configured',
                        })}
                    </span>
                ) : (
                    <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        {t('ai_settings.key_missing', {
                            defaultValue: 'Not configured',
                        })}
                    </span>
                )}
            </div>

            {local ? (
                <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">
                        {t('ai_settings.base_url', {
                            defaultValue: 'Base URL',
                        })}
                    </Label>
                    <div className="flex items-stretch gap-2">
                        <Input
                            value={draftBaseUrl}
                            onChange={(e) => setDraftBaseUrl(e.target.value)}
                            onBlur={() =>
                                setBaseUrl(provider, draftBaseUrl.trim())
                            }
                            placeholder="http://localhost:1234"
                            spellCheck={false}
                            className="flex-1 font-mono text-xs"
                        />
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={discovering}
                            onClick={handleFetchModels}
                        >
                            {discovering ? (
                                <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                                t('ai_settings.fetch_models', {
                                    defaultValue: 'Fetch models',
                                })
                            )}
                        </Button>
                    </div>
                    {discoveredModels && discoveredModels.length > 0 ? (
                        <div className="flex flex-col gap-1.5 pt-1">
                            <Label className="text-xs text-muted-foreground">
                                {t('ai_settings.loaded_models', {
                                    defaultValue: 'Loaded model',
                                })}
                            </Label>
                            <Select
                                value={modelByProvider[provider]}
                                onValueChange={(v) => setModel(provider, v)}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {discoveredModels.map((id) => (
                                        <SelectItem key={id} value={id}>
                                            {id}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    ) : null}
                </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">
                    {local
                        ? t('ai_settings.api_key_optional', {
                              defaultValue: 'API key (optional)',
                          })
                        : t('ai_settings.api_key', {
                              defaultValue: 'API key',
                          })}
                </Label>
                <div className="flex items-stretch gap-2">
                    <div className="relative flex-1">
                        <Input
                            type={revealed ? 'text' : 'password'}
                            value={draftKey}
                            onChange={(e) => onDraftChange(e.target.value)}
                            placeholder={t('ai_settings.api_key_placeholder', {
                                defaultValue: 'Paste your API key',
                            })}
                            autoComplete="off"
                            spellCheck={false}
                            className="pr-9 font-mono text-xs"
                        />
                        <button
                            type="button"
                            onClick={onToggleReveal}
                            className="absolute inset-y-0 end-0 inline-flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
                            aria-label={
                                revealed
                                    ? t('ai_settings.hide_key', {
                                          defaultValue: 'Hide key',
                                      })
                                    : t('ai_settings.reveal_key', {
                                          defaultValue: 'Reveal key',
                                      })
                            }
                        >
                            {revealed ? (
                                <EyeOff className="size-4" />
                            ) : (
                                <Eye className="size-4" />
                            )}
                        </button>
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={testing || (!draftKey.trim() && !local)}
                        onClick={onTest}
                    >
                        {testing ? (
                            <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                            t('ai_settings.test', { defaultValue: 'Test' })
                        )}
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        disabled={!dirty}
                        onClick={onSave}
                    >
                        {t('ai_settings.save', { defaultValue: 'Save' })}
                    </Button>
                </div>
            </div>

            {currentModel ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                        <span className="text-foreground">
                            {currentModel.label}
                        </span>{' '}
                        · {formatTokens(currentModel.contextWindow)} ctx
                    </span>
                    <span>
                        ${currentModel.inputCostPer1M.toFixed(2)} / $
                        {currentModel.outputCostPer1M.toFixed(2)} per 1M
                    </span>
                </div>
            ) : null}
        </div>
    );
};

const BehaviorSection: React.FC = () => {
    const { t } = useTranslation();
    const {
        safetyMode,
        setSafetyMode,
        temperature,
        setTemperature,
        maxOutputTokens,
        setMaxOutputTokens,
        maxIterations,
        setMaxIterations,
        showCost,
        setShowCost,
    } = useAIConfig();

    return (
        <>
            <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-medium">
                    {t('ai_settings.safety_mode', {
                        defaultValue: 'Safety mode',
                    })}
                </Label>
                <Select
                    value={safetyMode}
                    onValueChange={(v) => setSafetyMode(v as AISafetyMode)}
                >
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="ask">
                            {t('ai_settings.safety_ask', {
                                defaultValue:
                                    'Ask before destructive changes (recommended)',
                            })}
                        </SelectItem>
                        <SelectItem value="auto">
                            {t('ai_settings.safety_auto', {
                                defaultValue: 'Auto-apply all changes',
                            })}
                        </SelectItem>
                        <SelectItem value="dry-run">
                            {t('ai_settings.safety_dry_run', {
                                defaultValue: 'Dry run — never mutate',
                            })}
                        </SelectItem>
                    </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                    {t('ai_settings.safety_help', {
                        defaultValue:
                            'Controls whether deletes and bulk schema changes require your confirmation.',
                    })}
                </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <NumberField
                    label={t('ai_settings.temperature', {
                        defaultValue: 'Temperature',
                    })}
                    help={t('ai_settings.temperature_help', {
                        defaultValue: '0 = deterministic, 1 = creative.',
                    })}
                    value={temperature}
                    onChange={setTemperature}
                    min={0}
                    max={2}
                    step={0.1}
                />
                <NumberField
                    label={t('ai_settings.max_output_tokens', {
                        defaultValue: 'Max output tokens',
                    })}
                    help={t('ai_settings.max_output_tokens_help', {
                        defaultValue: 'Hard cap on response length per turn.',
                    })}
                    value={maxOutputTokens}
                    onChange={setMaxOutputTokens}
                    min={256}
                    max={64000}
                    step={256}
                />
                <NumberField
                    label={t('ai_settings.max_iterations', {
                        defaultValue: 'Max tool iterations',
                    })}
                    help={t('ai_settings.max_iterations_help', {
                        defaultValue:
                            'Limit on agentic loops; 16 is a good default for large schema imports.',
                    })}
                    value={maxIterations}
                    onChange={setMaxIterations}
                    min={1}
                    max={32}
                    step={1}
                />
                <div className="flex items-start justify-between gap-2 rounded-md border p-3">
                    <div className="flex flex-col">
                        <span className="text-sm font-medium">
                            {t('ai_settings.show_cost', {
                                defaultValue: 'Show cost meter',
                            })}
                        </span>
                        <span className="text-xs text-muted-foreground">
                            {t('ai_settings.show_cost_help', {
                                defaultValue:
                                    'Display estimated USD next to each reply.',
                            })}
                        </span>
                    </div>
                    <Button
                        type="button"
                        size="sm"
                        variant={showCost ? 'default' : 'outline'}
                        onClick={() => setShowCost(!showCost)}
                    >
                        {showCost
                            ? t('ai_settings.on', { defaultValue: 'On' })
                            : t('ai_settings.off', { defaultValue: 'Off' })}
                    </Button>
                </div>
            </div>
        </>
    );
};

interface PrivacySectionProps {
    confirming: boolean;
    onRequestClear: () => void;
    onCancelClear: () => void;
    onConfirmClear: () => void;
}

const PrivacySection: React.FC<PrivacySectionProps> = ({
    confirming,
    onRequestClear,
    onCancelClear,
    onConfirmClear,
}) => {
    const { t } = useTranslation();
    return (
        <>
            <div className="rounded-md border bg-muted/30 p-4 text-sm leading-relaxed text-muted-foreground">
                <p className="mb-2 text-foreground">
                    {t('ai_settings.privacy_heading', {
                        defaultValue: 'Where does your data go?',
                    })}
                </p>
                <ul className="list-disc space-y-1.5 pl-5">
                    <li>
                        {t('ai_settings.privacy_keys', {
                            defaultValue:
                                'API keys are AES-GCM encrypted and stored only in this browser.',
                        })}
                    </li>
                    <li>
                        {t('ai_settings.privacy_requests', {
                            defaultValue:
                                'Chat messages and your schema are sent directly to the selected provider — ChartDB never sees them.',
                        })}
                    </li>
                    <li>
                        {t('ai_settings.privacy_history', {
                            defaultValue:
                                'Conversation history is saved locally and, when signed in, mirrored to your private Firestore document.',
                        })}
                    </li>
                </ul>
            </div>

            <div className="rounded-md border border-red-500/20 bg-red-500/5 p-4">
                <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" />
                    <div className="flex-1">
                        <p className="text-sm font-medium text-foreground">
                            {t('ai_settings.danger_zone', {
                                defaultValue: 'Danger zone',
                            })}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {t('ai_settings.clear_all_help', {
                                defaultValue:
                                    'Removes every AI key, model preference, and assistant setting from this device. Cloud chat history is not affected.',
                            })}
                        </p>
                        <div className="mt-3 flex gap-2">
                            {confirming ? (
                                <>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="destructive"
                                        onClick={onConfirmClear}
                                    >
                                        <Trash2 className="size-3.5" />
                                        {t('ai_settings.confirm_clear', {
                                            defaultValue: 'Yes, clear all',
                                        })}
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        onClick={onCancelClear}
                                    >
                                        {t('ai_settings.cancel', {
                                            defaultValue: 'Cancel',
                                        })}
                                    </Button>
                                </>
                            ) : (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={onRequestClear}
                                >
                                    <Trash2 className="size-3.5" />
                                    {t('ai_settings.clear_all', {
                                        defaultValue: 'Clear AI data',
                                    })}
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
};

interface NumberFieldProps {
    label: string;
    help?: string;
    value: number;
    onChange: (v: number) => void;
    min: number;
    max: number;
    step: number;
}

const NumberField: React.FC<NumberFieldProps> = ({
    label,
    help,
    value,
    onChange,
    min,
    max,
    step,
}) => (
    <div className="flex flex-col gap-1.5 rounded-md border p-3">
        <Label className="text-xs font-medium">{label}</Label>
        <Input
            type="number"
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next)) {
                    onChange(Math.min(max, Math.max(min, next)));
                }
            }}
        />
        {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1000)}k`;
    return String(n);
}

/**
 * Provider connectivity smoke test. We hit a cheap public endpoint with
 * the supplied key and validate the response shape. Used by the "Test"
 * button in settings before Phase 3 adapters land. Each provider has a
 * well-defined `GET /models`-style endpoint that returns 401 on a bad key.
 */
async function pingProvider(
    provider: AIProvider,
    key: string,
    baseUrl: string | undefined
): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
        let res: Response;
        switch (provider) {
            case 'openai':
                res = await fetch('https://api.openai.com/v1/models', {
                    headers: { Authorization: `Bearer ${key}` },
                    signal: controller.signal,
                });
                break;
            case 'anthropic':
                res = await fetch('https://api.anthropic.com/v1/models', {
                    headers: {
                        'x-api-key': key,
                        'anthropic-version': '2023-06-01',
                        'anthropic-dangerous-direct-browser-access': 'true',
                    },
                    signal: controller.signal,
                });
                break;
            case 'gemini':
                res = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
                    { signal: controller.signal }
                );
                break;
            case 'lmstudio': {
                const trimmed = (baseUrl ?? 'http://localhost:1234').replace(
                    /\/+$/u,
                    ''
                );
                const url = /\/v1$/u.test(trimmed)
                    ? `${trimmed}/models`
                    : `${trimmed}/v1/models`;
                const headers: Record<string, string> = {};
                if (key) headers.Authorization = `Bearer ${key}`;
                res = await fetch(url, {
                    headers,
                    signal: controller.signal,
                });
                break;
            }
            case 'deepseek':
                res = await fetch(buildDeepSeekModelsUrl(baseUrl), {
                    headers: { Authorization: `Bearer ${key}` },
                    signal: controller.signal,
                });
                break;
        }
        if (!res.ok) {
            const detail = await safeReadText(res);
            throw new Error(
                `${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`
            );
        }
    } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
            throw new Error('Request timed out after 10s');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

async function safeReadText(res: Response): Promise<string> {
    try {
        const text = await res.text();
        // Trim large bodies to keep toasts readable.
        return text.length > 200 ? text.slice(0, 200) + '…' : text;
    } catch {
        return '';
    }
}

// Suppress unused import warning when AI_MODELS isn't referenced — keeps
// the module a stable barrel for downstream phases.
void AI_MODELS;
