package com.crazy4lamb.crmbi.core;

import java.util.concurrent.ThreadPoolExecutor;
import org.springframework.boot.autoconfigure.task.TaskSchedulingProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

/**
 * 调度线程池配置。
 *
 * <p>Spring Boot 默认提供一个单线程的 {@code TaskScheduler}，多个任务会互相排队；
 * 这里按 {@code task.scheduling.pool.size} 显式给一个线程池。
 */
@Configuration
public class SchedulingConfig {

  @Bean
  public ThreadPoolTaskScheduler taskScheduler(TaskSchedulingProperties properties) {
    ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
    scheduler.setPoolSize(Math.max(1, properties.getPool().getSize()));
    scheduler.setThreadNamePrefix("crm-sched-");
    scheduler.setWaitForTasksToCompleteOnShutdown(true);
    scheduler.setAwaitTerminationSeconds(30);
    // 到点的任务不应因前一个未完成而被丢弃
    scheduler.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
    return scheduler;
  }
}
