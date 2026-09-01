# 33. Тестирование движков и контракт адаптера (§62, §63)

Статус: реализовано в `@nexus/integrations` (`src/contract.ts`, `src/testkit/contract.ts`).
Связано: `10_INTEGRATIONS.md` §3 (стадии pipeline), §13 (conformance harness), `32_LICENSE_AND_SAFE_DEFAULTS.md` (§60/§61).

## Зачем

§63 требует: **если новый adapter нарушает контракт — он не должен попадать в production registry.**
Контракт разделён на две половины, потому что реестр не имеет права выполнять чужой код парсера
во время загрузки процесса:

| Половина      | Где живёт                                                   | Когда проверяется                                                              | Что делает при нарушении                                                                   |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Статическая   | `src/contract.ts` → `checkStaticContract(manifest, parser)` | в `buildRegistry()` на каждый source                                           | source **не попадает в `entries`**, уходит в `registry.rejected` с `path: contract.<name>` |
| Поведенческая | `src/testkit/contract.ts` → `checkAdapterContract(source)`  | в CI (`test/contract.builtins.test.ts` прогоняет её по всем `BUILTIN_SOURCES`) | падает тест — PR не мержится                                                               |

Обе возвращают **все** нарушения сразу, а не первое: автор адаптера не должен узнавать о них
по одному прогону CI за штуку.

## Шесть контрактов (§63)

| Контракт               | Проверяется               | Правила                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Input Contract**     | статически + поведенчески | required-поле не может быть `derived` без default; selection-поле обязано называть entity kinds; `accepts()` возвращает boolean; `adapt()` на пустом invocation либо возвращает результат, либо бросает `IntegrationError`, но не голый `TypeError`; targets не выходят за `consent.allowedTargetScopes` |
| **Execution Contract** | статически                | `network.mode = allowlist` при пустом allowlist запрещён; `output.maxBytes ≤ limits.maxOutputBytes`; число outputs ≤ `limits.maxArtifacts`; для контейнера primary output должен собираться из `path` или `fromStdout`                                                                                   |
| **Progress Contract**  | поведенчески              | парсер обязан завершить маленький fixture в пределах бюджета (по умолчанию 5 000 мс) — и на корректных байтах, и на мусоре; зависший парсер = нарушение                                                                                                                                                  |
| **Result Contract**    | поведенчески              | `records` — массив; у каждой записи непустой `pointer`, разбираемый `observedAt`, `parserConfidence ∈ [0,1]`; counters — неотрицательные числа; `nonFatalIssues` не содержит пустых сообщений; два прогона одного fixture дают одинаковые записи (duplicate handling)                                    |
| **Error Contract**     | поведенчески              | любой отказ парсера — `IntegrationError` с кодом из таксономии §11, никогда не `TypeError`/строка. Отказ на пустом или битом входе допустим; **непрозрачный** отказ — нет                                                                                                                                |
| **Metadata Contract**  | статически                | `parser.schemaVersions` непуст и пересекается с `manifest.parser.supportedOutputVersions`; манифест, который вообще не парсится, — тоже нарушение metadata                                                                                                                                               |

## Категории тестов движка (§62)

| Категория §62        | Где реализована                                                   |
| -------------------- | ----------------------------------------------------------------- |
| Unit                 | обычные vitest-тесты пакета (`test/*.test.ts`)                    |
| Integration          | `test/pipeline.*.test.ts`, `test/apply.items.test.ts`             |
| Adapter              | `checkAdapterContract` — один вызов на адаптер                    |
| Health               | `evaluateSafeDefaults` (check `health`, §61)                      |
| Timeout              | бюджет в `checkAdapterContract({ budgetMs })` — Progress Contract |
| Failure              | Error Contract: прогон парсера по заведомо неверным байтам        |
| Output normalization | Result Contract: pointer / observedAt / confidence / counters     |
| Duplicate handling   | Result Contract: повторный прогон одного fixture                  |

## Как подключить новый адаптер

```ts
import { assertAdapterContract } from '@nexus/integrations/testkit';

it('honours the adapter contract', async () => {
  await assertAdapterContract({ raw: myManifest, parser: myParser });
});
```

Плюс одна строка в `BUILTIN_SOURCES` — `test/contract.builtins.test.ts` подхватит адаптер сам.

## Что не сделано

- Статическая половина не проверяет поведение `extractor` / `nodeMapper` / `relationshipMapper`:
  у встроенных источников они по умолчанию манифест-driven и покрыты property-тестом pipeline.
- Нет проверки того, что парсер **стримит** артефакт вместо буферизации (§3.4): требует счётчика
  чтения в `ParseContext`, отдельная задача.
- Бюджет Progress Contract измеряет только парсер; таймауты стадии execution живут в runner и
  проверяются его собственными тестами.
- Нет fixture-корпуса на адаптер (golden files) — `checkAdapterContract` использует пустой вход и
  мусор; предметные fixtures остаются в тестах конкретного адаптера.
