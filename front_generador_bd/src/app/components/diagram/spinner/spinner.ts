import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-spinner',
  imports: [],
  templateUrl: './spinner.html',
  styleUrls: ['./spinner.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Spinner { }
