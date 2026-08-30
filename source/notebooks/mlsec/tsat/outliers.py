from typing import List, Tuple
from statsmodels.tsa.seasonal import seasonal_decompose
import logging
import numpy as np
import pandas as pd


class TSATOutlierDetector:
    def __init__(self, data: pd.Series, decomp: str = "additive", iqr_mult: float = 3.0) -> None:
        self.data = data
        self.decomp = decomp
        self.iqr_mult = iqr_mult
        self.outliers: List[List[Tuple[pd.Timestamp, float]]] = []
        self.outliers_index: List[pd.Timestamp] = []

    def detector(self) -> List[List[Tuple[pd.Timestamp, float]]]:
        outliers = self.__clean_ts__(self._to_dataframe(self.data))
        self.outliers = [outliers]
        return self.outliers

    @staticmethod
    def _to_dataframe(data: pd.Series) -> pd.DataFrame:
        if not isinstance(data, pd.Series):
            raise TypeError("TSATOutlierDetector expects a pandas Series")
        frame = data.to_frame(name="y")
        frame.index = pd.to_datetime(frame.index)
        return frame.sort_index()

    def __clean_ts__(self, original: pd.DataFrame) -> List[Tuple[pd.Timestamp, float]]:
        """
        Detect outliers by decomposing the time series and measuring residuals
        against an interquartile-range threshold.
        """
        original = original.copy()

        if pd.infer_freq(original.index) is None:
            original = original.asfreq("D")
            logging.info("Setting frequency to daily since it cannot be inferred")

        try:
            original = original.interpolate(
                method="polynomial", limit_direction="both", order=3
            )
        except ValueError:
            original = original.interpolate(method="linear", limit_direction="both")

        if original["y"].isna().any():
            original = original.interpolate(method="linear", limit_direction="both")

        original = original.dropna()
        if len(original) < 4:
            self.outliers_index = []
            return []

        period = self._infer_period(original.index, len(original))
        result = seasonal_decompose(
            original["y"],
            model=self.decomp,
            period=period,
            extrapolate_trend="freq",
        )

        rem = result.resid
        detrend = original["y"] - result.trend
        strength = float(1 - np.nanvar(rem) / np.nanvar(detrend))
        values = original["y"] - result.seasonal if strength >= 0.6 else original["y"]

        resid = values - result.trend
        resid_q = np.nanpercentile(resid.dropna(), [25, 75])
        iqr = resid_q[1] - resid_q[0]
        if iqr == 0 or np.isnan(iqr):
            self.outliers_index = []
            return []

        iqr_mults = resid.abs() / iqr
        outliers_iqr_mults = iqr_mults[iqr_mults > self.iqr_mult].dropna()
        self.outliers_index = list(outliers_iqr_mults.index)
        return list(zip(self.outliers_index, outliers_iqr_mults.astype(float)))

    @staticmethod
    def _infer_period(index: pd.DatetimeIndex, series_length: int) -> int:
        if series_length >= 14:
            return 7
        return max(2, min(series_length // 2, 7))
