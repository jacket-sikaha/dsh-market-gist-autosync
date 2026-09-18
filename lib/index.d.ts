import z from '@deepseek-ai/schemastery';
/**
 * dsh-market-gist-autosync — 把 DSH 配置定时备份到 GitHub Gist。
 *
 * Host half only for the first minimal version: gist token / gist id 配置、
 * 配置备份（带错误分类）、自持定时备份，全部在一个插件里完成。
 * Client 设置页在后续版本补上；当前通过 RPC + 一个模型工具暴露能力。
 */
declare const name = "dsh-market-gist-autosync";
declare const inject: string[];
declare const Config: z<Schemastery.ObjectS<{
    scheduleIntervalHours: z<number, number>;
    gistApiHost: z<string, string>;
}>, Schemastery.ObjectT<{
    scheduleIntervalHours: z<number, number>;
    gistApiHost: z<string, string>;
}>>;
declare function apply(ctx: any, rawConfig: any): Promise<void>;
export { name, inject, Config, apply };
