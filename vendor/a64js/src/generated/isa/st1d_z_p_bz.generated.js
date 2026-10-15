export const ENCODINGS = [
    {
        "instructionId": "st1d_z_p_bz",
        "encodingId": "st1d_z_p_bz_d_64_scaled",
        "mnemonic": "ST1D",
        "className": "64-bit scaled offset",
        "fileName": "st1d_z_p_bz.xml",
        "mask": 4292927488,
        "value": 3852509184,
        "bitCount": 14,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-contiguous-byte-memory"
    },
    {
        "instructionId": "st1d_z_p_bz",
        "encodingId": "st1d_z_p_bz_d_64_unscaled",
        "mnemonic": "ST1D",
        "className": "64-bit unscaled offset",
        "fileName": "st1d_z_p_bz.xml",
        "mask": 4292927488,
        "value": 3850412032,
        "bitCount": 14,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-contiguous-byte-memory"
    },
    {
        "instructionId": "st1d_z_p_bz",
        "encodingId": "st1d_z_p_bz_d_x32_scaled",
        "mnemonic": "ST1D",
        "className": "32-bit unpacked scaled offset",
        "fileName": "st1d_z_p_bz.xml",
        "mask": 4292911104,
        "value": 3852500992,
        "bitCount": 13,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "xs",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-contiguous-byte-memory"
    },
    {
        "instructionId": "st1d_z_p_bz",
        "encodingId": "st1d_z_p_bz_d_x32_unscaled",
        "mnemonic": "ST1D",
        "className": "32-bit unpacked unscaled offset",
        "fileName": "st1d_z_p_bz.xml",
        "mask": 4292911104,
        "value": 3850403840,
        "bitCount": 13,
        "fields": [
            {
                "name": "msz",
                "lsb": 23,
                "width": 2
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "xs",
                "lsb": 14,
                "width": 1
            },
            {
                "name": "Pg",
                "lsb": 10,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-contiguous-byte-memory"
    }
];
