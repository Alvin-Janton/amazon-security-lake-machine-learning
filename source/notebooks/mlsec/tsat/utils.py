import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from dataclasses import dataclass
from datetime import datetime, timedelta
import re

from statsmodels.tsa.seasonal import seasonal_decompose
from statsmodels.tsa.stattools import adfuller
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_squared_error

from .outliers import TSATOutlierDetector

# def convert_from_kats(kats_ts):
#     return kats_ts.to_dataframe().set_index('time')


# def convert_to_kats(ts):
#     tmp = ts.to_frame(name='value').reset_index()
#     tmp.columns = ['time', 'value']
#     return TimeSeriesData(tmp)


# def plot_single_timeseries(ts, ax=None, figsize=(12,4), xlabel='date', ylabel=None, alpha=1., color='tab:blue',
#                            linewidth=1., grid=True, **plot_kwargs):
#     if ax is None: fig, ax = plt.subplots(figsize=figsize)
#     if isinstance(ts, TimeSeriesData): ts = convert_from_kats(ts)
#     ts.plot(ax=ax, alpha=alpha, color=color, linewidth=linewidth, legend=False, **plot_kwargs)
#     ax.set_xlabel(xlabel)
#     ax.set_ylabel(ylabel)
#     if grid: ax.grid(which='minor', axis='x')
#     return ax


def plot_timeseries_panel(timeseries, titles=None, ylabels=None, nrows=7, ncols=3, figsize=(20,30), print_idx_ylabel=True):
    """
        timeseries (list[pd.Series]): List of Series with a timestamp index.
    """
    fig, axs = plt.subplots(nrows, ncols, figsize=figsize, sharex=False)
    axx = axs.ravel()
    if ylabels is None: ylabels = [''] * len(axx)
    if print_idx_ylabel: ylabels = [yl + f' (index={i})' for i,yl in enumerate(ylabels)]
    for i, (ax, ylabel) in enumerate(zip(axx, ylabels)):
        ax = plot_single_timeseries(timeseries[i], ax, ylabel=ylabel)
        if titles is not None: ax.set_title(titles[i])
    fig.tight_layout()
    return fig, axx


def plot_timeseries_decomp(ts, model='additive', figsize=(12,12)):
    result = seasonal_decompose(ts, model=model)
    fig = result.plot()
    fig.set_figwidth(figsize[0])
    fig.set_figheight(figsize[1])
    for ax in fig.axes: ax.grid()
    plt.show()

def plot_single_timeseries(ts, ax=None, figsize=(12,4), xlabel='date', ylabel=None, alpha=1., color='tab:blue',
                           linewidth=1., grid=True, **plot_kwargs):
    return MiloTimeseries.plot_single_timeseries(
        ts, ax, figsize, xlabel, ylabel, alpha, color, linewidth, grid, **plot_kwargs)


def plot_vertical_timestamp_lines(ax, timestamps, alpha=1.0):
    return MiloTimeseries.plot_vertical_timestamp_lines(ax, timestamps, alpha)


class MiloTimeseries:
    
    STABLE_NRMSE_THRESH=5.
    TREND_NSLOPE_THRESH=1.
    
    def __init__(self, ts, keyvals={}, source_sql=''):
        
        assert(isinstance(ts, pd.Series))
        if keyvals is not None: assert(isinstance(keyvals, dict))
        
        self.ts = ts
        self.keyvals = keyvals
        self._wheres, self._selects = None, None
        self.source_sql = source_sql
        
        self.outliers = None
        self._max_outlier_iqr_mult = None
        
        self.changepoints = None
        
        self.stationarity_results = None
        self._is_stationary = None
        
        self._slope = None
        
        self._stable_trend = None
        
    def plot(self, ax=None, figsize=(12,4), xlabel='date', ylabel=None, alpha=1., color='tab:blue',
                           linewidth=1., grid=True, **plot_kwargs):
        
        ax = self.plot_single_timeseries(self.ts, ax, figsize, xlabel, ylabel, alpha, color, 
                                         linewidth, grid, marker='o', title=self.title, **plot_kwargs)
        return ax
    
    def plot_outliers(self):
        if self.outliers is None: raise AttributeError('This time series has not been assigned any outliers')
        if len(self.outliers) == 0:
            print('This timeseries has no outliers')
            return
        ax = self.plot()
        ax = self.plot_vertical_timestamp_lines(ax, timestamps=[o.timestamp for o in self.outliers], alpha=0.5)
        return ax
    
    def plot_changepoints(self):
        if self.changepoints is None: raise AttributeError('This time series has not been assigned any change points')
        if len(self.changepoints) == 0:
            print('This timeseries has no change points')
            return
        ax = self.plot()
        ax = self.plot_vertical_timestamp_lines(ax, timestamps=[o.timestamp for o in self.changepoints], alpha=0.5)
        return ax
    
    def generation_sql(self, time_window=None):
        # TODO: add time window functionality
        select_txt = 'select timestamp, value, ' + ', '.join(self.selects)
        wheres = self.wheres.copy()
        if time_window is not None:
            assert isinstance(time_window, list)
            assert len(time_window) == 2
            wheres.append(f"timestamp between timestamp '{time_window[0]}' and timestamp '{time_window[1]}'")
        where_txt = 'where ' + '\nand '.join(wheres)
        sql = select_txt + ' from ( ' + self.source_sql + ') a ' + where_txt
        return sql
    
    def constituent_findings_sql(self, time_window=None):
        sql = self.source_sql.replace('count(*) as value', '*')
        sql = re.sub(r'group by.*', '', sql)
        if time_window:
            assert isinstance(time_window, list)
            assert len(time_window) == 2
            sql = 'select * from (\n' + sql + f"\n) a\nwhere timestamp between timestamp '{time_window[0]}' and timestamp '{time_window[1]}'"
        return sql
    
    def _construct_selects_wheres(self):
        selects = []
        wheres = []
        for key, val in self.keyvals.items():
            selects.append(key)
            wheres.append(key + "='" + val + "'")
        self._selects, self._wheres = selects, wheres
        
    def stability_trend_analysis(self):
        reg = LinearRegression()
        X = np.array(range(len(self.ts))).reshape(-1, 1)
        y = np.array(self.ts.values).reshape(-1, 1)
        reg = reg.fit(X, y)
        y_pred = reg.predict(X)
        rmse = mean_squared_error(y, y_pred)
        avg_res = np.abs(y - y_pred).mean()
        ts_mean = self.ts.mean()
        nslope = reg.coef_[0,0] / ts_mean
        nrmse = rmse / ts_mean
        is_stable = nrmse < self.STABLE_NRMSE_THRESH
        if not is_stable: return 'unstable'
        if nslope > self.TREND_NSLOPE_THRESH:
            stable_trend = 'positive'
        elif nslope < (self.TREND_NSLOPE_THRESH * -1):
            stable_trend = 'negative'
        else:
            stable_trend = 'flat'
        return stable_trend
    
    @property
    def stable_trend(self):
        if not self._stable_trend:
            self._stable_trend = self.stability_trend_analysis()
        return self._stable_trend
            
    @property
    def wheres(self):
        if self._wheres is None: 
            self._construct_selects_wheres()
        return self._wheres
        
    @property
    def selects(self):
        if self._selects is None:
            self._construct_selects_wheres()
        return self._selects
        
    @property
    def title(self):
        return ' and '.join(self.wheres)
        
    @property
    def kats_ts(self):
        return self.ts
    
    @property
    def max_outlier_iqr_mult(self):
        if self.outliers is None: raise AttributeError('This time series has not been assigned any outliers')
        if self._max_outlier_iqr_mult is None:
            self._max_outlier_iqr_mult = max([o.iqr_mult for o in self.outliers])
        return self._max_outlier_iqr_mult
    
    @property
    def is_stationary(self):
        if self._is_stationary is None: 
            if self.stationarity_results is None: raise AttributeError('Stationarity results have not been set')
            self._is_stationary = self.stationarity_results.p_value < 0.05
        return self._is_stationary
    
    @property
    def slope(self):
        if self._slope is None:
            self._slope = self.compute_timeseries_slope(self.ts)
        return self._slope
        
    @staticmethod
    def plot_single_timeseries(ts, ax=None, figsize=(12,4), xlabel='date', ylabel=None, alpha=1., color='tab:blue',
                           linewidth=1., grid=True, **plot_kwargs):
        if ax is None: fig, ax = plt.subplots(figsize=figsize)
        ts.plot(ax=ax, alpha=alpha, color=color, linewidth=linewidth, legend=False, **plot_kwargs)
        ax.set_xlabel(xlabel)
        ax.set_ylabel(ylabel)
        if grid: ax.grid(which='minor', axis='x')
        return ax
    
    @staticmethod
    def plot_vertical_timestamp_lines(ax, timestamps, alpha=1.0):
        for timestamp in timestamps:
            _ = ax.axvline(x=timestamp, color='red', alpha=alpha)
        return ax
    
    @staticmethod
    def convert_from_kats(kats_ts):
        raise NotImplementedError('Kats is no longer used; pass pandas Series values directly')

    @staticmethod
    def convert_to_kats(ts):
        raise NotImplementedError('Kats is no longer used; pass pandas Series values directly')
    
    @staticmethod
    def compute_timeseries_slope(ts, order=1):
        result = np.polyfit(range(len(ts)), list(ts), order)
        slope = result[-2]
        return float(slope)
    
    
class TimestampOfInterest:
    
    def __init__(self, timestamp):
        assert isinstance(timestamp, pd.Timestamp)
        self.timestamp = timestamp
        
    def generate_investigation_sql(self, milo_ts, window_days=0):
        window_left = self.timestamp - timedelta(days=window_days)
        window_right = self.timestamp + timedelta(days=window_days)
        return milo_ts.generation_sql(time_window=[window_left, window_right])
        
        

class MiloOutlier(TimestampOfInterest):
    
    def __init__(self, timestamp, iqr_mult):
        super().__init__(timestamp=timestamp)
        self.iqr_mult = iqr_mult
        
    def __str__(self):
        return f'Outlier at {self.timestamp}, with IQR multiple of {self.iqr_mult: .3f}'


def get_outliers(milo_ts, iqr_mult_thresh=5., decomp='additive'):
    outlier_detector = TSATOutlierDetector(milo_ts.ts, decomp=decomp, iqr_mult=iqr_mult_thresh)
    outlier_detector.detector()
    outliers = outlier_detector.outliers[0]
    milo_outliers = []
    for outlier in outliers:
        outlier_timestamp, iqr_mult = outlier
        milo_outliers.append(MiloOutlier(outlier_timestamp, iqr_mult))
    return milo_outliers


@dataclass
class ADFullerStationarityResults:
    adf_test_statistic: float
    p_value: float
    num_lags_used: int
    nobs: int
    critical_values: dict
        
        
def get_stationarity_results(milo_ts):
    out = adfuller(milo_ts.ts)
    results = ADFullerStationarityResults(
        adf_test_statistic=out[0],
        p_value=out[1],
        num_lags_used=out[2],
        nobs=out[3],
        critical_values=out[4])
    return results


class MiloChangepoint(TimestampOfInterest):
    
    def __init__(self, timestamp, conf, direction, metadata=None):
        super().__init__(timestamp=timestamp)
        self.conf = conf
        self.direction = direction
        self.metadata = metadata
        
    def __str__(self):
        return f'Change point ({self.direction}) at {self.timestamp} with confidence {self.conf}'
    
    
def get_changepoints(milo_ts, threshold=0.01, detector_kwargs={}):
    try:
        import ruptures as rpt
    except ImportError as exc:
        raise ImportError("ruptures is required for change point detection. Install it with `pip install ruptures`.") from exc

    ts = milo_ts.ts.dropna().sort_index()
    if len(ts) < 4:
        return []

    values = ts.to_numpy(dtype=float).reshape(-1, 1)
    model = detector_kwargs.get("model", "l2")
    algorithm = detector_kwargs.get("algorithm", "pelt")
    min_size = detector_kwargs.get("min_size", 2)
    jump = detector_kwargs.get("jump", 1)
    penalty = detector_kwargs.get("penalty", max(float(threshold) * len(ts), 1.0))

    if algorithm == "binseg":
        n_bkps = detector_kwargs.get("n_bkps", 1)
        change_points = rpt.Binseg(model=model, min_size=min_size, jump=jump).fit(values).predict(n_bkps=n_bkps)
    else:
        change_points = rpt.Pelt(model=model, min_size=min_size, jump=jump).fit(values).predict(pen=penalty)

    milo_changepoints = []
    for change_point in change_points:
        if change_point >= len(ts):
            continue
        before = ts.iloc[:change_point]
        after = ts.iloc[change_point:]
        if before.empty or after.empty:
            continue
        direction = "increase" if after.mean() > before.mean() else "decrease"
        milo_cp = MiloChangepoint(
            timestamp=ts.index[change_point],
            conf=1.0,
            direction=direction,
            metadata={"algorithm": algorithm, "model": model, "penalty": penalty})
        milo_changepoints.append(milo_cp)
    return milo_changepoints
