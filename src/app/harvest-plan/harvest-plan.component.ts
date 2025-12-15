import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { PanelModule } from 'primeng/panel';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { TooltipModule } from 'primeng/tooltip';
import { MessagesModule } from 'primeng/messages';
import { MessageModule } from 'primeng/message';
import { ChipsModule } from 'primeng/chips';

export interface HarvestPlanInputs {
  groupCount: number;
  anodeDays: number;
  cathodePhases: [number, number, number];
  cleaningDays: number;
  harvestOrder: number[];
  groupStartOffsetDays: number;
}

export type PhaseType =
  | 'anode'
  | 'cathode-in'
  | 'cathode-out'
  | 'cathode-reinserted'
  | 'cleaning';

export interface PlanPhase {
  name: string;
  startDay: number;
  endDay: number;
  durationDays: number;
  type: PhaseType;
}

export interface PlanEvent {
  name: string;
  day: number;
}

export interface GroupPlan {
  group: number;
  startDay: number;
  endDay: number;
  phases: PlanPhase[];
  events: PlanEvent[];
  harvestDay: number;
  cleaningRange?: string;
  cathodeOutRange: string;
}

@Component({
  selector: 'app-harvest-plan',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    CardModule,
    PanelModule,
    InputNumberModule,
    InputTextModule,
    ButtonModule,
    TableModule,
    TooltipModule,
    MessagesModule,
    MessageModule,
    ChipsModule,
  ],
  templateUrl: './harvest-plan.component.html',
  styleUrls: ['./harvest-plan.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HarvestPlanComponent implements OnInit {
  form: FormGroup;
  plan: GroupPlan[] = [];
  maxPlanDay = 0;
  timelineDays = 42;
  messages: { severity: 'error' | 'warn' | 'info'; detail: string }[] = [];
  readonly defaults = {
    groupCount: 8,
    anodeDays: 14,
    cathodeA: 5,
    cathodeB: 5,
    cathodeC: 4,
    cleaningDays: 0,
    groupStartOffsetDays: 1,
  };

  constructor(private readonly fb: FormBuilder) {
    this.form = this.fb.group({
      groupCount: [this.defaults.groupCount, [Validators.required, Validators.min(1), Validators.max(100)]],
      anodeDays: [this.defaults.anodeDays, [Validators.required, Validators.min(1), Validators.max(365)]],
      cathodeA: [this.defaults.cathodeA, [Validators.required, Validators.min(0)]],
      cathodeB: [this.defaults.cathodeB, [Validators.required, Validators.min(0)]],
      cathodeC: [this.defaults.cathodeC, [Validators.required, Validators.min(0)]],
      cleaningDays: [this.defaults.cleaningDays, [Validators.required, Validators.min(0), Validators.max(60)]],
      harvestOrder: [this.defaultOrder(this.defaults.groupCount), Validators.required],
      groupStartOffsetDays: [
        this.defaults.groupStartOffsetDays,
        [Validators.required, Validators.min(0), Validators.max(30)],
      ],
    });
  }

  ngOnInit(): void {
    this.form.valueChanges
      .pipe(debounceTime(300), distinctUntilChanged())
      .subscribe(() => this.validateForm(false));
    this.generatePlan();
  }

  normalizeCathodes(): void {
    const anodeDays = this.form.get('anodeDays')?.value as number;
    const cathodeA = this.form.get('cathodeA')?.value as number;
    const cathodeB = this.form.get('cathodeB')?.value as number;
    const remaining = Math.max(anodeDays - cathodeA - cathodeB, 0);
    this.form.patchValue({ cathodeC: remaining });
  }

  resetDefaults(): void {
    this.form.reset({
      groupCount: this.defaults.groupCount,
      anodeDays: this.defaults.anodeDays,
      cathodeA: this.defaults.cathodeA,
      cathodeB: this.defaults.cathodeB,
      cathodeC: this.defaults.cathodeC,
      cleaningDays: this.defaults.cleaningDays,
      harvestOrder: this.defaultOrder(this.defaults.groupCount),
      groupStartOffsetDays: this.defaults.groupStartOffsetDays,
    });
    this.messages = [];
    this.generatePlan();
  }

  generatePlan(): void {
    this.messages = [];
    const validationPassed = this.validateForm(true);
    if (!validationPassed) {
      this.plan = [];
      this.maxPlanDay = 0;
      return;
    }

    const inputs: HarvestPlanInputs = {
      groupCount: this.form.value.groupCount,
      anodeDays: this.form.value.anodeDays,
      cathodePhases: [this.form.value.cathodeA, this.form.value.cathodeB, this.form.value.cathodeC],
      cleaningDays: this.form.value.cleaningDays,
      harvestOrder: this.parseHarvestOrder(this.form.value.harvestOrder, this.form.value.groupCount),
      groupStartOffsetDays: this.form.value.groupStartOffsetDays,
    };

    this.plan = this.buildPlan(inputs);
    this.maxPlanDay = this.plan.reduce((max, gp) => Math.max(max, gp.endDay), 0);
    this.timelineDays = Math.max(42, this.maxPlanDay || 0);
  }

  exportCsv(): void {
    if (!this.plan.length) {
      return;
    }
    const header = 'Group,Start Day,End Day,Cathode Out Range,Harvest Day,Cleaning Range';
    const rows = this.plan.map((p) =>
      [p.group, p.startDay, p.endDay, p.cathodeOutRange, p.harvestDay, p.cleaningRange ?? '-'].join(','),
    );
    const csvContent = [header, ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'harvest-plan.csv';
    link.click();
    window.URL.revokeObjectURL(url);
  }

  get cathodeSumMismatch(): boolean {
    const anodeDays = this.form.get('anodeDays')?.value as number;
    const sum = this.cathodeSum;
    return sum !== anodeDays;
  }

  get cathodeSum(): number {
    const cathodeA = this.form.get('cathodeA')?.value as number;
    const cathodeB = this.form.get('cathodeB')?.value as number;
    const cathodeC = this.form.get('cathodeC')?.value as number;
    return (cathodeA ?? 0) + (cathodeB ?? 0) + (cathodeC ?? 0);
  }

  get maxDaysArray(): number[] {
    return Array.from({ length: this.timelineDays }, (_, i) => i + 1);
  }

  barStyle(phase: PlanPhase): Record<string, string> {
    const left = ((phase.startDay - 1) / this.timelineDays) * 100;
    const width = (phase.durationDays / this.timelineDays) * 100;
    return {
      left: `${left}%`,
      width: `${width}%`,
    };
  }

  phaseClass(type: PhaseType): string {
    switch (type) {
      case 'anode':
        return 'phase-anode';
      case 'cathode-in':
        return 'phase-cathode-in';
      case 'cathode-out':
        return 'phase-cathode-out';
      case 'cathode-reinserted':
        return 'phase-cathode-reinserted';
      case 'cleaning':
        return 'phase-cleaning';
      default:
        return '';
    }
  }

  private validateForm(showErrors: boolean): boolean {
    const errors: { severity: 'error' | 'warn' | 'info'; detail: string }[] = [];

    if (this.form.invalid) {
      errors.push({ severity: 'error', detail: 'Bitte alle Pflichtfelder korrekt ausfüllen.' });
    }

    const groupCount = this.form.get('groupCount')?.value as number;
    const orderRaw = this.form.get('harvestOrder')?.value as string;
    const order = this.parseHarvestOrder(orderRaw, groupCount);
    if (!order.length) {
      errors.push({ severity: 'error', detail: 'Harvest-Reihenfolge ist ungültig.' });
    }

    if (this.cathodeSumMismatch) {
      errors.push({ severity: 'warn', detail: 'Summe der Kathoden-Phasen entspricht nicht anodeDays.' });
    }

    if (showErrors) {
      this.messages = errors;
    }

    return errors.filter((e) => e.severity === 'error').length === 0;
  }

  private parseHarvestOrder(value: string, groupCount: number): number[] {
    if (!value) {
      return [];
    }
    const numbers = value
      .split(/[,\s]+/)
      .map((token) => Number(token))
      .filter((num) => Number.isInteger(num) && num > 0);

    if (numbers.length !== groupCount) {
      return [];
    }

    const unique = Array.from(new Set(numbers));
    const isPermutation =
      unique.length === groupCount &&
      unique.every((n) => n >= 1 && n <= groupCount) &&
      unique.sort((a, b) => a - b).every((n, idx) => n === idx + 1);

    return isPermutation ? numbers : [];
  }

  private buildPlan(inputs: HarvestPlanInputs): GroupPlan[] {
    const plans: GroupPlan[] = [];

    inputs.harvestOrder.forEach((groupNumber, index) => {
      const startDay = 1 + index * inputs.groupStartOffsetDays;
      const [cathodeA, cathodeB, cathodeC] = inputs.cathodePhases;
      const anodeEnd = startDay + inputs.anodeDays - 1;
      const cathodeOutStart = startDay + cathodeA;
      const cathodeOutEnd = cathodeOutStart + cathodeB - 1;
      const cathodeReinsertStart = cathodeOutEnd + 1;
      const cathodeReinsertEnd = cathodeReinsertStart + cathodeC - 1;
      const harvestDay = anodeEnd + 1;
      const cleaningStart = anodeEnd + 1;
      const cleaningEnd = cleaningStart + inputs.cleaningDays - 1;
      const cleaningRange =
        inputs.cleaningDays > 0 ? `${cleaningStart} - ${cleaningEnd}` : undefined;

      const phases: PlanPhase[] = [
        {
          name: 'Anode im Elektrolyt',
          startDay,
          endDay: anodeEnd,
          durationDays: inputs.anodeDays,
          type: 'anode',
        },
        {
          name: 'Kathoden drin',
          startDay,
          endDay: startDay + cathodeA - 1,
          durationDays: cathodeA,
          type: 'cathode-in',
        },
        {
          name: 'Kathoden entfernt',
          startDay: cathodeOutStart,
          endDay: cathodeOutEnd,
          durationDays: cathodeB,
          type: 'cathode-out',
        },
        {
          name: 'Kathoden wieder eingesetzt',
          startDay: cathodeReinsertStart,
          endDay: cathodeReinsertEnd,
          durationDays: cathodeC,
          type: 'cathode-reinserted',
        },
      ];

      if (inputs.cleaningDays > 0) {
        phases.push({
          name: 'Cleaning',
          startDay: cleaningStart,
          endDay: cleaningEnd,
          durationDays: inputs.cleaningDays,
          type: 'cleaning',
        });
      }

      const events: PlanEvent[] = [
        { name: 'Einheben', day: startDay },
        { name: 'Kathoden raus', day: cathodeOutStart },
        { name: 'Kathoden rein', day: cathodeReinsertStart },
        { name: 'Harvest/Anoden raus', day: harvestDay },
      ];

      if (inputs.cleaningDays > 0) {
        events.push({ name: 'Cleaning done', day: cleaningEnd + 1 });
      }

      const endDay = inputs.cleaningDays > 0 ? cleaningEnd + 1 : harvestDay;

      plans.push({
        group: groupNumber,
        startDay,
        endDay,
        phases,
        events,
        harvestDay,
        cleaningRange,
        cathodeOutRange: `${cathodeOutStart} - ${cathodeOutEnd}`,
      });
    });

    return plans.sort((a, b) => a.group - b.group);
  }

  private defaultOrder(groupCount: number): string {
    return Array.from({ length: groupCount }, (_, i) => i + 1).join(',');
  }
}
