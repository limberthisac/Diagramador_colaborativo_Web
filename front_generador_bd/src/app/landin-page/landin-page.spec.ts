import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LandinPage } from './landin-page';

describe('LandinPage', () => {
  let component: LandinPage;
  let fixture: ComponentFixture<LandinPage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LandinPage]
    })
    .compileComponents();

    fixture = TestBed.createComponent(LandinPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
