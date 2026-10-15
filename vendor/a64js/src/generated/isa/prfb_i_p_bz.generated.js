export const ENCODINGS = [
    {
        "instructionId": "prfb_i_p_bz",
        "encodingId": "prfb_i_p_bz_d_64_scaled",
        "mnemonic": "PRFB",
        "className": "64-bit scaled offset",
        "fileName": "prfb_i_p_bz.xml",
        "mask": 4292927504,
        "value": 3294658560,
        "bitCount": 15,
        "fields": [
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "msz",
                "lsb": 13,
                "width": 2
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
                "name": "prfop",
                "lsb": 0,
                "width": 4
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
        "operandFamilyId": "sve-scalar-immediate-prefetch"
    },
    {
        "instructionId": "prfb_i_p_bz",
        "encodingId": "prfb_i_p_bz_d_x32_scaled",
        "mnemonic": "PRFB",
        "className": "32-bit unpacked scaled offset",
        "fileName": "prfb_i_p_bz.xml",
        "mask": 4288733200,
        "value": 3290431488,
        "bitCount": 14,
        "fields": [
            {
                "name": "xs",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "msz",
                "lsb": 13,
                "width": 2
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
                "name": "prfop",
                "lsb": 0,
                "width": 4
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
        "operandFamilyId": "sve-scalar-immediate-prefetch"
    },
    {
        "instructionId": "prfb_i_p_bz",
        "encodingId": "prfb_i_p_bz_s_x32_scaled",
        "mnemonic": "PRFB",
        "className": "32-bit scaled offset",
        "fileName": "prfb_i_p_bz.xml",
        "mask": 4288733200,
        "value": 2216689664,
        "bitCount": 14,
        "fields": [
            {
                "name": "xs",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "msz",
                "lsb": 13,
                "width": 2
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
                "name": "prfop",
                "lsb": 0,
                "width": 4
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
        "operandFamilyId": "sve-scalar-immediate-prefetch"
    }
];
