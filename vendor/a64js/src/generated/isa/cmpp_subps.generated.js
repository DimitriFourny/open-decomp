export const ENCODINGS = [
    {
        "instructionId": "CMPP_SUBPS",
        "encodingId": "CMPP_SUBPS_64S_dp_2src",
        "mnemonic": "SUBPS",
        "className": "Integer",
        "fileName": "cmpp_subps.xml",
        "mask": 4292934687,
        "value": 3133145119,
        "bitCount": 22,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 29,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "opcode",
                "lsb": 10,
                "width": 6
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_MTE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_MTE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "canonicalEncodingId": "SUBPS_64S_dp_2src",
        "canonicalFileName": "subps.xml",
        "operandFamilyId": "mte-subtract-pointer"
    }
];
